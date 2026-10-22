/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {ParsedArguments} from './config/ConfigParser.js';
import {
  acquireLaunchLock,
  buildRegularUserAgent,
  buildGpuArgs,
  buildProxyArgs,
  countBusyPages,
  detectChromeMajorVersion,
  ensureWatchdog,
  findInPath,
  isSharedBrowserStale,
  readSharedBrowserState,
  resolveDisplayMode,
  resolveSharedEndpoint,
  shutdownSharedBrowser,
  spawnSharedBrowser,
  startVirtualDisplay,
  VIRTUAL_DISPLAY_SIZE,
  type DisplayMode,
  type VirtualDisplay,
} from './SharedBrowser.js';
import type {
  Browser,
  ChromeReleaseChannel,
  LaunchOptions,
} from './third_party/index.js';
import {Mutex, puppeteer} from './third_party/index.js';
import {logger, puppeteerLogger} from './utils/logger.js';
import {isAllowedUrl} from './utils/url.js';

/**
 * Puppeteer flags that mark the browser as automated. `--enable-automation`
 * sets `navigator.webdriver` and shows the "controlled by automated test
 * software" bar; sites use both to block bots. Dropped from every launch so
 * the browser looks like one a person opened.
 */
export const AUTOMATION_CHROME_ARGS = ['--enable-automation'];

export interface BrowserManagerOptions {
  logFile?: fs.WriteStream;
}

/**
 * Identity token for an in-flight connect/launch attempt. Instances carry no
 * data and are never inspected structurally — only ever compared by
 * reference (`!==`) — see BrowserManager#abandonPendingAttempt().
 */
class BrowserAttempt {}

export class BrowserManager {
  #browser?: Browser;
  #browserMode?: 'launched' | 'connected' | 'shared';
  #sharedUserDataDir?: string;
  #initPromise?: Promise<Browser>;
  #mutex = new Mutex();
  #closingCount = 0;
  #serverArgs: ParsedArguments;
  #options: BrowserManagerOptions;

  #browserAttempt: BrowserAttempt = new BrowserAttempt();

  constructor(
    serverArgs: ParsedArguments,
    options: BrowserManagerOptions = {},
  ) {
    this.#serverArgs = serverArgs;
    this.#options = options;
  }

  static makeTargetFilter(enableExtensions = false) {
    return function targetFilter(target: {url(): string}): boolean {
      const url = target.url();
      if (!url) {
        return true;
      }
      return isAllowedUrl(url, {categoryExtensions: enableExtensions});
    };
  }

  /**
   * Whether this server shares one long-lived Chrome with other servers
   * instead of launching (and later closing) its own. Explicit connection
   * targets and `--isolated` take precedence over `--shared-browser`.
   */
  static isSharedMode(args: ParsedArguments): boolean {
    return (
      Boolean(args.sharedBrowser) &&
      !args.isolated &&
      !args.browserUrl &&
      !args.wsEndpoint &&
      !args.autoConnect
    );
  }

  /**
   * The display mode the user asked for. `--headless` is kept as a shorthand
   * for `--display-mode=headless`.
   */
  static requestedDisplayMode(args: ParsedArguments): DisplayMode {
    if (args.headless) {
      return 'headless';
    }
    return args.displayMode ?? 'virtual';
  }

  /**
   * Starts a private Xvfb display for a browser launched by this server.
   * Returns `undefined`, after saying why, when no virtual display can be
   * had here; the caller then runs headless.
   */
  static async startVirtualDisplay(): Promise<VirtualDisplay | undefined> {
    const {mode, xvfbRunPath, reason} = resolveDisplayMode(
      'virtual',
      os.platform(),
      findInPath('Xvfb'),
      'Xvfb',
    );
    if (mode !== 'virtual' || !xvfbRunPath) {
      console.error(`[chrome-devtools-mcp] ${reason}`);
      return undefined;
    }
    try {
      return await startVirtualDisplay(xvfbRunPath);
    } catch (err) {
      console.error(
        `[chrome-devtools-mcp] Could not start a virtual display; running headless instead. ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  static detectDisplay(): void {
    // Only detect display on Linux/UNIX.
    if (os.platform() === 'win32' || os.platform() === 'darwin') {
      return;
    }
    if (!process.env['DISPLAY']) {
      try {
        const result = execSync(
          `ps -u $(id -u) -o pid= | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\\0' '\\n' | grep -m1 '^DISPLAY=' | cut -d= -f2`,
        );
        const display = result.toString('utf8').trim();
        process.env['DISPLAY'] = display;
      } catch {
        // no-op
      }
    }
  }

  /**
   * Chrome refuses to start as root unless the sandbox is explicitly disabled and
   * only says so on its stderr. Because we launch with `pipe: true`, Puppeteer
   * never surfaces that stderr and the failure reaches the client as an opaque
   * `Protocol error (Target.setDiscoverTargets): Target closed`. Detect the
   * situation and explain the way out instead. See https://crbug.com/638180.
   *
   * Returns `undefined` when the failure cannot be explained by running as root,
   * including on platforms without uids and when the sandbox was already disabled
   * through `--chrome-arg` (in which case root is not what stopped Chrome).
   */
  static rootSandboxLaunchError(
    error: Error,
    args: readonly string[],
    uid = process.getuid?.(),
  ): Error | undefined {
    if (uid !== 0) {
      return undefined;
    }
    if (
      args.some(
        arg => arg === '--no-sandbox' || arg.startsWith('--no-sandbox='),
      )
    ) {
      return undefined;
    }
    return new Error(
      `Chrome failed to start: ${error.message}\n\n` +
        'chrome-devtools-mcp is running as root and Chrome does not start as root ' +
        '(https://crbug.com/638180). Run chrome-devtools-mcp as a non-root user; in a ' +
        'container, create an unprivileged user in the image and switch to it with ' +
        "USER. For the setup that Chrome's sandbox needs, see " +
        'https://pptr.dev/troubleshooting#setting-up-chrome-linux-sandbox.',
      {
        cause: error,
      },
    );
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.#initPromise) {
      return await this.#initPromise;
    }
    const initPromise = this.#ensureBrowserLocked();
    this.#initPromise = initPromise;
    try {
      return await initPromise;
    } finally {
      if (this.#initPromise === initPromise) {
        this.#initPromise = undefined;
      }
    }
  }

  async #ensureBrowserLocked(): Promise<Browser> {
    if (this.#closingCount > 0) {
      throw new Error('Browser was closed while initializing.');
    }
    // Captured before acquiring #mutex, not after: a caller queued here can
    // have its own timeout fire (abandonPendingAttempt()) while it's still
    // waiting for the lock. Capturing only after acquiring it would let such
    // a call silently adopt the freshly-rotated token as its own baseline
    // once the lock frees up, defeating the abandonment check entirely.
    const attempt = this.#browserAttempt;
    using guard = await this.#mutex.acquire();
    if (this.#closingCount > 0) {
      throw new Error('Browser was closed while initializing.');
    }
    if (this.#browserAttempt !== attempt) {
      // Abandoned while queued for the lock — #browser was never touched by
      // this call, so bail immediately without #closeBrowser(), which could
      // otherwise tear down a different, still-current attempt's browser.
      throw new Error('Connection attempt was abandoned before it completed.');
    }
    if (!this.#browser?.connected) {
      await this.#initBrowser();
    }
    if (
      this.#closingCount > 0 ||
      this.#browserAttempt !== attempt ||
      !this.#browser
    ) {
      const reason =
        this.#closingCount > 0
          ? 'Browser was closed while initializing.'
          : 'Connection attempt was abandoned before it completed.';
      await this.#closeBrowser();
      throw new Error(reason);
    }
    return this.#browser;
  }

  /**
   * Signals that whoever was waiting on the in-flight ensureBrowser() call
   * has given up (e.g. a tool-call timeout). There's no way to cancel a
   * pending connect()/launch(), so this doesn't stop it — it rotates the
   * token to a fresh value and clears #initPromise, so a late-resolving
   * attempt gets discarded by #ensureBrowserLocked() instead of silently
   * installed for a caller who already walked away.
   *
   * Also forgets the cached #browser, if any. This only ever fires from a
   * getContext()-level timeout, which covers both ensureBrowser() and the
   * McpContext initialization built on it — if ensureBrowser() already
   * resolved and it's that later step hanging (e.g. a dead CDP transport),
   * the token rotation alone does nothing, since #browser is already
   * cached. Safe to forget unconditionally here: the tool mutex serializes
   * every call, so there's no concurrent caller to disrupt.
   */
  abandonPendingAttempt(): void {
    this.#browserAttempt = new BrowserAttempt();
    this.#initPromise = undefined;
    if (this.#browser) {
      this.forget(this.#browser);
    }
  }

  async #initBrowser(): Promise<Browser> {
    if (
      this.#serverArgs.browserUrl ||
      this.#serverArgs.wsEndpoint ||
      this.#serverArgs.autoConnect
    ) {
      return await this.#connect();
    }
    if (BrowserManager.isSharedMode(this.#serverArgs)) {
      return await this.#connectShared();
    }
    return await this.#launch();
  }

  /**
   * Resolves the profile directory. Isolated launches return `undefined` so
   * Puppeteer creates a temporary profile; otherwise the persistent profile
   * under `~/.cache` is created on demand.
   */
  async #resolveUserDataDir(): Promise<string | undefined> {
    const {channel, isolated = false, viaCli} = this.#serverArgs;
    const profileDirName =
      channel && channel !== 'stable'
        ? `chrome-profile-${channel}`
        : 'chrome-profile';

    let userDataDir = this.#serverArgs.userDataDir;
    if (!isolated && !userDataDir) {
      userDataDir = path.join(
        os.homedir(),
        '.cache',
        viaCli ? 'chrome-devtools-mcp-cli' : 'chrome-devtools-mcp',
        profileDirName,
      );
    }
    if (userDataDir) {
      await fs.promises.mkdir(userDataDir, {
        recursive: true,
      });
    }
    return userDataDir;
  }

  #puppeteerChannel(): ChromeReleaseChannel {
    const {channel} = this.#serverArgs;
    return channel && channel !== 'stable' ? `chrome-${channel}` : 'chrome';
  }

  async #sharedConnectOptions(): Promise<
    Parameters<typeof puppeteer.connect>[0]
  > {
    const {
      categoryExtensions: enableExtensions,
      blockedUrlPattern: blocklist,
      allowedUrlPattern: allowlist,
      acceptInsecureCerts,
    } = this.#serverArgs;
    return {
      targetFilter: BrowserManager.makeTargetFilter(enableExtensions),
      defaultViewport: null,
      handleDevToolsAsPage: true,
      acceptInsecureCerts,
      blocklist,
      allowlist,
      logger: puppeteerLogger,
    };
  }

  /**
   * Connects to the shared Chrome for this profile, launching it first when
   * none is running. See SharedBrowser.ts for the overall scheme.
   */
  async #connectShared(): Promise<Browser> {
    const userDataDir = await this.#resolveUserDataDir();
    if (!userDataDir) {
      throw new Error('A user data directory is required for a shared browser');
    }
    this.#sharedUserDataDir = userDataDir;
    const connectOptions = await this.#sharedConnectOptions();

    let browser = await this.#tryConnectShared(userDataDir, connectOptions);
    if (browser && (await this.#restartIfStaleAndIdle(browser, userDataDir))) {
      browser = undefined;
    }
    if (!browser) {
      const release = await acquireLaunchLock(userDataDir);
      try {
        // Another server may have launched Chrome while we waited for the lock.
        browser = await this.#tryConnectShared(userDataDir, connectOptions);
        if (!browser) {
          const wsUrl = await this.#spawnShared(userDataDir);
          browser = await puppeteer.connect({
            ...connectOptions,
            browserWSEndpoint: wsUrl,
          });
        }
      } finally {
        release();
      }
    }

    logger?.('Connected to the shared browser');
    try {
      ensureWatchdog(
        userDataDir,
        this.#serverArgs.browserIdleTimeoutMinutes ?? 0,
        this.#serverArgs.sharedBrowserPort,
      );
    } catch (err) {
      logger?.('Failed to ensure the shared browser watchdog', err);
    }
    this.#browserMode = 'shared';
    this.#browser = browser;
    const shared = browser;
    shared.once('disconnected', () => this.#evictIfCurrent(shared));
    return shared;
  }

  async #tryConnectShared(
    userDataDir: string,
    connectOptions: Parameters<typeof puppeteer.connect>[0],
  ): Promise<Browser | undefined> {
    let wsUrl: string;
    try {
      wsUrl = await resolveSharedEndpoint(
        userDataDir,
        this.#serverArgs.sharedBrowserPort,
      );
    } catch {
      return undefined;
    }
    try {
      return await puppeteer.connect({
        ...connectOptions,
        browserWSEndpoint: wsUrl,
      });
    } catch (err) {
      logger?.(
        `Shared browser endpoint ${wsUrl} is not reachable, launching a new one`,
        err,
      );
      return undefined;
    }
  }

  /**
   * Replaces a browser older than `--browser-max-age-hours`, but only while no
   * tab of any server is doing anything, so another agent's work is never cut
   * off. Returns true when the browser was shut down.
   */
  async #restartIfStaleAndIdle(
    browser: Browser,
    userDataDir: string,
  ): Promise<boolean> {
    const maxAgeHours = this.#serverArgs.browserMaxAgeHours ?? 0;
    const state = readSharedBrowserState(userDataDir);
    if (!isSharedBrowserStale(state, maxAgeHours)) {
      return false;
    }
    const busy = countBusyPages(browser);
    if (busy > 0) {
      logger?.(
        `Shared browser is older than ${maxAgeHours}h but ${busy} page(s) are in use; restart deferred`,
      );
      return false;
    }
    logger?.(`Shared browser is older than ${maxAgeHours}h; restarting it`);
    await shutdownSharedBrowser(browser, userDataDir);
    return true;
  }

  async #spawnShared(userDataDir: string): Promise<string> {
    const {
      executablePath: configuredExecutablePath,
      proxyServer,
      proxyDomains,
      gpu,
      chromeArg,
      sharedBrowserPort,
    } = this.#serverArgs;
    const executablePath =
      configuredExecutablePath ??
      (await puppeteer.executablePath(this.#puppeteerChannel()));

    const {mode, xvfbRunPath, reason} = resolveDisplayMode(
      BrowserManager.requestedDisplayMode(this.#serverArgs),
      os.platform(),
      findInPath('xvfb-run'),
    );
    if (reason) {
      console.error(`[chrome-devtools-mcp] ${reason}`);
    }
    if (mode === 'headed') {
      BrowserManager.detectDisplay();
    }
    let userAgent: string | undefined;
    if (mode === 'headless') {
      const major = await detectChromeMajorVersion(executablePath);
      if (major !== undefined) {
        userAgent = buildRegularUserAgent(major);
      }
    }
    return await spawnSharedBrowser(
      {
        executablePath,
        userDataDir,
        displayMode: mode,
        debuggingPort: sharedBrowserPort,
        userAgent,
        proxyServer,
        proxyDomains,
        gpu,
        extraArgs: chromeArg,
      },
      xvfbRunPath,
    );
  }

  async #launch(): Promise<Browser> {
    const {
      executablePath,
      categoryExtensions: enableExtensions,
      viewport,
      acceptInsecureCerts,
      experimentalDevtools: devtools = false,
      blockedUrlPattern: blocklist,
      allowedUrlPattern: allowlist,
      ignoreDefaultChromeArg,
      proxyServer,
    } = this.#serverArgs;

    const userDataDir = await this.#resolveUserDataDir();

    const args: LaunchOptions['args'] = [
      ...(this.#serverArgs.chromeArg ?? []),
      ...buildProxyArgs(proxyServer, this.#serverArgs.proxyDomains),
    ];
    args.push(
      '--hide-crash-restore-bubble',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    );

    const ignoreDefaultArgs: LaunchOptions['ignoreDefaultArgs'] = [
      ...AUTOMATION_CHROME_ARGS,
      ...(ignoreDefaultChromeArg ?? []),
    ];

    let mode = BrowserManager.requestedDisplayMode(this.#serverArgs);
    let virtualDisplay: VirtualDisplay | undefined;
    if (mode === 'virtual') {
      virtualDisplay = await BrowserManager.startVirtualDisplay();
      mode = virtualDisplay ? 'virtual' : 'headless';
    }
    const headless = mode === 'headless';
    args.push(...buildGpuArgs(mode, this.#serverArgs.gpu));
    let env: Record<string, string | undefined> | undefined;
    if (virtualDisplay) {
      // Keep Chrome on the Xvfb X server even when the desktop session is
      // Wayland, and let WebGL work without a real GPU.
      env = {
        ...process.env,
        DISPLAY: virtualDisplay.display,
        WAYLAND_DISPLAY: undefined,
      };
      args.push(
        '--ozone-platform=x11',
        '--enable-unsafe-swiftshader',
        `--window-size=${VIRTUAL_DISPLAY_SIZE.width},${VIRTUAL_DISPLAY_SIZE.height}`,
        '--window-position=0,0',
      );
    }

    if (headless) {
      args.push('--screen-info={3840x2160}');
    }
    let puppeteerChannel: ChromeReleaseChannel | undefined;
    if (devtools) {
      args.push('--auto-open-devtools-for-tabs');
    }
    if (!executablePath) {
      puppeteerChannel = this.#puppeteerChannel();
    }

    if (mode === 'headed') {
      BrowserManager.detectDisplay();
    }

    let browser: Browser | undefined;
    try {
      browser = await puppeteer.launch({
        channel: puppeteerChannel,
        targetFilter: BrowserManager.makeTargetFilter(enableExtensions),
        executablePath,
        defaultViewport: null,
        userDataDir,
        pipe: true,
        headless,
        env,
        args,
        ignoreDefaultArgs,
        acceptInsecureCerts,
        handleDevToolsAsPage: true,
        enableExtensions,
        blocklist,
        allowlist,
        logger: puppeteerLogger,
      });
      if (this.#options.logFile) {
        // FIXME: we are probably subscribing too late to catch startup logs. We
        // should expose the process earlier or expose the getRecentLogs() getter.
        browser.process()?.stderr?.pipe(this.#options.logFile);
        browser.process()?.stdout?.pipe(this.#options.logFile);
      }
      if (viewport) {
        const [page] = await browser.pages();
        await page?.resize({
          contentWidth: viewport.width,
          contentHeight: viewport.height,
        });
      }
      if (virtualDisplay) {
        const display = virtualDisplay;
        browser.once('disconnected', () => display.close());
      }
      this.#browserMode = 'launched';
      this.#browser = browser;
      const launched = browser;
      launched.once('disconnected', () => this.#evictIfCurrent(launched));
      return launched;
    } catch (error) {
      await browser?.close().catch(() => {
        // Best-effort cleanup if post-launch setup failed.
      });
      virtualDisplay?.close();
      if (
        userDataDir &&
        error instanceof Error &&
        error.message.includes('The browser is already running')
      ) {
        throw new Error(
          `The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`,
          {
            cause: error,
          },
        );
      }
      if (error instanceof Error) {
        const rootError = BrowserManager.rootSandboxLaunchError(error, args);
        if (rootError) {
          throw rootError;
        }
      }
      throw error;
    }
  }

  async #connect(): Promise<Browser> {
    const {
      browserUrl: browserURL,
      wsEndpoint,
      wsHeaders,
      autoConnect: isAutoConnect,
      userDataDir,
      blockedUrlPattern: blocklist,
      allowedUrlPattern: allowlist,
    } = this.#serverArgs;
    // Important: only pass channel, if autoConnect is true.
    const channel = isAutoConnect ? this.#serverArgs.channel : undefined;

    const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
      targetFilter: BrowserManager.makeTargetFilter(),
      defaultViewport: null,
      handleDevToolsAsPage: true,
      blocklist,
      allowlist,
      logger: puppeteerLogger,
    };

    let autoConnect = false;
    if (wsEndpoint) {
      connectOptions.browserWSEndpoint = wsEndpoint;
      if (wsHeaders) {
        connectOptions.headers = wsHeaders;
      }
    } else if (browserURL) {
      connectOptions.browserURL = browserURL;
    } else if (channel || userDataDir) {
      if (userDataDir) {
        autoConnect = true;
        // TODO: re-expose this logic via Puppeteer.
        const portPath = path.join(userDataDir, 'DevToolsActivePort');
        try {
          const fileContent = await fs.promises.readFile(portPath, 'utf8');
          const [rawPort, rawPath] = fileContent
            .split('\n')
            .map(line => {
              return line.trim();
            })
            .filter(line => {
              return !!line;
            });
          if (!rawPort || !rawPath) {
            throw new Error(
              `Invalid DevToolsActivePort '${fileContent}' found`,
            );
          }
          const port = parseInt(rawPort, 10);
          if (isNaN(port) || port <= 0 || port > 65535) {
            throw new Error(`Invalid port '${rawPort}' found`);
          }
          const browserWSEndpoint = `ws://127.0.0.1:${port}${rawPath}`;
          connectOptions.browserWSEndpoint = browserWSEndpoint;
        } catch (error) {
          throw new Error(
            `Could not connect to Chrome in ${userDataDir}. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.`,
            {
              cause: error,
            },
          );
        }
      } else {
        if (!channel) {
          throw new Error('Channel must be provided if userDataDir is missing');
        }
        connectOptions.channel =
          channel === 'stable' ? 'chrome' : `chrome-${channel}`;
      }
    } else {
      throw new Error(
        'Either browserURL, wsEndpoint, channel or userDataDir must be provided',
      );
    }

    logger?.('Connecting Puppeteer to ', JSON.stringify(connectOptions));
    try {
      const connected = await puppeteer.connect(connectOptions);
      logger?.('Connected Puppeteer');
      this.#browserMode = 'connected';
      this.#browser = connected;
      connected.once('disconnected', () => this.#evictIfCurrent(connected));
      return connected;
    } catch (err) {
      throw new Error(
        `Could not connect to Chrome. ${autoConnect ? `Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.` : `Check if Chrome is running.`}`,
        {
          cause: err,
        },
      );
    }
  }

  /**
   * Clears the cached browser handle if it still matches `candidate`, so the
   * next ensureBrowser() call establishes a fresh connection instead of
   * reusing a handle that looks connected but is actually dead (e.g. its CDP
   * transport died without ever emitting a `close`/`disconnected` event — as
   * happens when an adb port-forward is torn down mid-call rather than
   * closed cleanly).
   *
   * Also actively tears `candidate` down in the background: closes it if it
   * was launched (so the Chrome subprocess doesn't leak), or disconnects if
   * it was only connected to (so the transport and its listeners don't
   * leak). This also settles any CDP call still pending against it —
   * Puppeteer's connection disposal synchronously rejects in-flight
   * callbacks — instead of leaving a hung call to leak forever.
   */
  forget(candidate: Browser): void {
    if (this.#browser !== candidate) {
      return;
    }
    const mode = this.#browserMode;
    this.#browser = undefined;
    this.#browserMode = undefined;
    if (mode === 'launched') {
      void this.#closeLaunchedBrowser(candidate);
    } else {
      void candidate.disconnect().catch(err => {
        logger?.('Failed to disconnect forgotten browser', err);
      });
    }
  }

  /**
   * Handles a `disconnected` event fired by a browser we hold: clears the
   * cached handle if it's still the current one, so the next ensureBrowser()
   * call reconnects proactively rather than only discovering the staleness
   * lazily on the next call's `!this.#browser?.connected` check. No teardown
   * here — the browser is already disconnected/closed, that's why this
   * fired — so this shares forget()'s identity guard without its cleanup,
   * making a `disconnected` that fires late on an already-superseded browser
   * a safe no-op.
   */
  #evictIfCurrent(candidate: Browser): void {
    if (this.#browser !== candidate) {
      return;
    }
    this.#browser = undefined;
    this.#browserMode = undefined;
  }

  async #closeLaunchedBrowser(browser: Browser): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        browser.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out closing browser')),
            5_000,
          );
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      logger?.('Failed to close browser', err);
      browser.process()?.kill('SIGKILL');
    } finally {
      clearTimeout(timer);
    }
  }

  async #closeBrowser(): Promise<void> {
    const browser = this.#browser;
    const mode = this.#browserMode;
    this.#browser = undefined;
    this.#browserMode = undefined;
    if (!browser || !browser.connected) {
      return;
    }
    if (mode === 'launched') {
      await this.#closeLaunchedBrowser(browser);
      return;
    }
    if (mode === 'shared' && this.#sharedUserDataDir) {
      // Last chance to retire an old browser without interrupting anyone: our
      // own tabs are already closed at this point, so if nothing else is in
      // use the next server gets a fresh Chrome.
      try {
        if (
          await this.#restartIfStaleAndIdle(browser, this.#sharedUserDataDir)
        ) {
          return;
        }
      } catch (err) {
        logger?.('Failed to retire the stale shared browser', err);
      }
    }
    await browser.disconnect().catch(err => {
      logger?.('Failed to disconnect from browser', err);
    });
  }

  /**
   * Shutdown hook for the active browser. Closes a launched browser (so the
   * Chrome subprocess is reaped) or disconnects from an attached browser (so
   * the user's Chrome instance stays alive). No-op if no browser is active or
   * the connection has already been dropped.
   */
  async close(): Promise<void> {
    this.#initPromise = undefined;
    this.#closingCount++;
    using guard = await this.#mutex.acquire();
    try {
      await this.#closeBrowser();
    } finally {
      this.#closingCount--;
    }
  }

  [Symbol.dispose](): void {
    this.close().catch(err => {
      logger?.('Failed to dispose BrowserManager', err);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
