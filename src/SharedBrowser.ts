/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Support for one long-lived Chrome that many MCP server instances share.
 *
 * The first server that needs a browser spawns Chrome detached (so it outlives
 * the server), records when it was launched, and connects over the DevTools
 * port Chrome writes to `DevToolsActivePort`. Later servers find that file and
 * simply connect. Every server works in tabs it created itself and closes
 * them on shutdown, leaving Chrome and its warm profile running for the next
 * one. A browser older than the configured maximum age is replaced the next
 * time a server connects while nobody else is using it.
 */

import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import type {Browser} from './third_party/index.js';
import {logger} from './utils/logger.js';

const execFileAsync = promisify(execFile);

export type DisplayMode = 'virtual' | 'headless' | 'headed';

export const SHARED_BROWSER_STATE_FILE = 'shared-browser.json';
export const SHARED_BROWSER_LOG_FILE = 'shared-browser.log';
export const WATCHDOG_LOG_FILE = 'shared-browser-watchdog.log';
export const WATCHDOG_SCRIPT_PATH = path.join(
  import.meta.dirname,
  'shared-browser-watchdog.js',
);
const LAUNCH_LOCK_FILE = 'shared-browser.lock';
const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

export const LAUNCH_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const POLL_INTERVAL_MS = 100;

export const VIRTUAL_DISPLAY_SIZE = {width: 1920, height: 1080};

/**
 * URLs a tab shows when nobody has navigated it yet. Tabs on these URLs do
 * not count as "in use" when deciding whether a stale browser may restart.
 */
const IDLE_PAGE_URLS = new Set(['', 'about:blank', 'chrome://newtab/']);

export interface SharedBrowserState {
  launchedAt: string;
  pid: number;
  displayMode: DisplayMode;
  // Pid of the idle watchdog looking after this browser, if one was started.
  watchdogPid?: number;
}

export interface DevToolsEndpoint {
  port: number;
  path: string;
}

export interface SharedLaunchOptions {
  executablePath: string;
  userDataDir: string;
  displayMode: DisplayMode;
  // DevTools port to listen on; 0 or undefined picks a free one.
  debuggingPort?: number;
  userAgent?: string;
  proxyServer?: string;
  extraArgs?: readonly string[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function findInPath(
  name: string,
  envPath = process.env['PATH'] ?? '',
): string | undefined {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * Picks the display mode that can actually be honoured on this machine.
 * `virtual` needs `xvfb-run` and only exists on Linux/UNIX; when it is not
 * available the browser runs headless, which still keeps every window off the
 * desktop. Returns the effective mode and, when it differs from the request,
 * a human readable reason.
 */
export function resolveDisplayMode(
  requested: DisplayMode,
  platform: NodeJS.Platform,
  xvfbRunPath: string | undefined,
  xvfbBinaryName = 'xvfb-run',
): {mode: DisplayMode; xvfbRunPath?: string; reason?: string} {
  if (requested !== 'virtual') {
    return {mode: requested};
  }
  if (platform === 'win32' || platform === 'darwin') {
    return {
      mode: 'headless',
      reason: `A virtual display is not available on ${platform}; running headless instead.`,
    };
  }
  if (!xvfbRunPath) {
    return {
      mode: 'headless',
      reason: `${xvfbBinaryName} was not found on PATH; running headless instead. Install Xvfb (e.g. \`pacman -S xorg-server-xvfb\` or \`apt install xvfb\`) to run a real window on a virtual display.`,
    };
  }
  return {mode: 'virtual', xvfbRunPath};
}

export interface VirtualDisplay {
  // Value for the DISPLAY environment variable, e.g. `:99`.
  display: string;
  close(): void;
}

/**
 * Starts an Xvfb server on a free display number for a browser this process
 * launches itself (the shared browser uses xvfb-run instead, since it has to
 * outlive us). Xvfb picks the number and reports it on fd 3 once it accepts
 * connections, so there is no race on the display lock files.
 */
export async function startVirtualDisplay(
  xvfbPath: string,
): Promise<VirtualDisplay> {
  const child = spawn(
    xvfbPath,
    [
      '-displayfd',
      '3',
      '-screen',
      '0',
      `${VIRTUAL_DISPLAY_SIZE.width}x${VIRTUAL_DISPLAY_SIZE.height}x24`,
      '-nolisten',
      'tcp',
      '-ac',
    ],
    {stdio: ['ignore', 'ignore', 'pipe', 'pipe']},
  );
  const close = (): void => {
    process.off('exit', close);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  };
  // Do not leave the X server behind when the server exits without closing
  // the browser first.
  process.once('exit', close);

  return await new Promise<VirtualDisplay>((resolve, reject) => {
    let displayOutput = '';
    let stderr = '';
    let settled = false;
    const fail = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      close();
      reject(new Error(stderr ? `${message}\n${stderr.trim()}` : message));
    };
    const timer = setTimeout(
      () => fail('Xvfb did not report a display in time'),
      LAUNCH_TIMEOUT_MS,
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdio[3]?.on('data', (chunk: Buffer) => {
      displayOutput += chunk.toString('utf8');
      const newline = displayOutput.indexOf('\n');
      if (newline === -1 || settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({display: `:${displayOutput.slice(0, newline).trim()}`, close});
    });
    child.once('error', err =>
      fail(`Xvfb could not be started: ${err.message}`),
    );
    child.once('exit', (code, signal) =>
      fail(`Xvfb exited with ${signal ?? `code ${code}`}`),
    );
  });
}

export function parseChromeMajorVersion(
  versionOutput: string,
): number | undefined {
  const match = versionOutput.match(/(\d+)\.\d+\.\d+\.\d+/);
  if (!match) {
    return undefined;
  }
  const major = Number.parseInt(match[1] ?? '', 10);
  return Number.isNaN(major) ? undefined : major;
}

/**
 * Builds the user agent a regular (headed) Chrome of the given major version
 * reports. Headless Chrome announces itself as `HeadlessChrome/…`, which many
 * sites treat as a bot; overriding the UA from the command line removes that
 * tell. Chrome already freezes the minor version to `0.0.0`.
 */
export function buildRegularUserAgent(
  major: number,
  platform: NodeJS.Platform = os.platform(),
): string {
  let platformToken = 'X11; Linux x86_64';
  if (platform === 'darwin') {
    platformToken = 'Macintosh; Intel Mac OS X 10_15_7';
  } else if (platform === 'win32') {
    platformToken = 'Windows NT 10.0; Win64; x64';
  }
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export async function detectChromeMajorVersion(
  executablePath: string,
): Promise<number | undefined> {
  try {
    const {stdout} = await execFileAsync(executablePath, ['--version'], {
      timeout: 10_000,
    });
    return parseChromeMajorVersion(stdout);
  } catch (err) {
    logger?.('Could not detect Chrome version', err);
    return undefined;
  }
}

/**
 * Arguments for a Chrome that should look like one a person opened: no
 * `--enable-automation` (which sets `navigator.webdriver` and shows the
 * "controlled by automated test software" bar), no disabled features, no
 * test-only switches. Only what is needed to run unattended with a dedicated
 * profile and a debugging port.
 */
export function buildSharedChromeArgs(
  options: Omit<SharedLaunchOptions, 'executablePath'>,
): string[] {
  const {
    userDataDir,
    displayMode,
    userAgent,
    proxyServer,
    extraArgs,
    debuggingPort,
  } = options;
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debuggingPort ?? 0}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--password-store=basic',
    `--window-size=${VIRTUAL_DISPLAY_SIZE.width},${VIRTUAL_DISPLAY_SIZE.height}`,
    '--window-position=0,0',
  ];
  if (displayMode === 'virtual') {
    // Keep Chrome on the Xvfb X server even when the desktop session is
    // Wayland, and let WebGL work without a real GPU.
    args.push('--ozone-platform=x11', '--enable-unsafe-swiftshader');
  }
  if (displayMode === 'headless') {
    args.push('--headless=new', '--enable-unsafe-swiftshader');
    if (userAgent) {
      args.push(`--user-agent=${userAgent}`);
    }
  }
  if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`);
  }
  args.push(...(extraArgs ?? []));
  if (args.every(arg => arg.startsWith('-'))) {
    args.push('about:blank');
  }
  return args;
}

export function getStatePath(userDataDir: string): string {
  return path.join(userDataDir, SHARED_BROWSER_STATE_FILE);
}

export function readSharedBrowserState(
  userDataDir: string,
): SharedBrowserState | undefined {
  try {
    const raw = fs.readFileSync(getStatePath(userDataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'launchedAt' in parsed &&
      typeof parsed.launchedAt === 'string' &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      'displayMode' in parsed &&
      (parsed.displayMode === 'virtual' ||
        parsed.displayMode === 'headless' ||
        parsed.displayMode === 'headed')
    ) {
      const state: SharedBrowserState = {
        launchedAt: parsed.launchedAt,
        pid: parsed.pid,
        displayMode: parsed.displayMode,
      };
      if ('watchdogPid' in parsed && typeof parsed.watchdogPid === 'number') {
        state.watchdogPid = parsed.watchdogPid;
      }
      return state;
    }
  } catch {
    // Missing or unreadable: treated as unknown age.
  }
  return undefined;
}

export function writeSharedBrowserState(
  userDataDir: string,
  state: SharedBrowserState,
): void {
  fs.writeFileSync(getStatePath(userDataDir), JSON.stringify(state, null, 2));
}

/**
 * Whether the browser described by `state` has outlived `maxAgeHours`. A
 * browser without a state file (launched by something else, or by an older
 * version) is never considered stale, since its age is unknown.
 */
export function isSharedBrowserStale(
  state: SharedBrowserState | undefined,
  maxAgeHours: number,
  now = Date.now(),
): boolean {
  if (!state || maxAgeHours <= 0) {
    return false;
  }
  const launchedAt = Date.parse(state.launchedAt);
  if (Number.isNaN(launchedAt)) {
    return false;
  }
  return now - launchedAt > maxAgeHours * 60 * 60 * 1000;
}

/**
 * Pages that some session is actively using: anything that is not a blank
 * tab. The keeper tab Chrome opened at startup and tabs other servers have
 * just created but not navigated yet are blank, so they do not count.
 */
export function countBusyPages(browser: Browser): number {
  let busy = 0;
  for (const target of browser.targets()) {
    if (target.type() !== 'page') {
      continue;
    }
    if (!IDLE_PAGE_URLS.has(target.url())) {
      busy++;
    }
  }
  return busy;
}

export async function readDevToolsEndpoint(
  userDataDir: string,
): Promise<DevToolsEndpoint> {
  const portPath = path.join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
  const fileContent = await fs.promises.readFile(portPath, 'utf8');
  const [rawPort, rawPath] = fileContent
    .split('\n')
    .map(line => line.trim())
    .filter(line => !!line);
  if (!rawPort || !rawPath) {
    throw new Error(`Invalid DevToolsActivePort '${fileContent}' found`);
  }
  const port = Number.parseInt(rawPort, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port '${rawPort}' found`);
  }
  return {port, path: rawPath};
}

export function devToolsEndpointToWsUrl(endpoint: DevToolsEndpoint): string {
  return `ws://127.0.0.1:${endpoint.port}${endpoint.path}`;
}

/**
 * Finds the browser WebSocket URL of the shared Chrome. Chrome only writes
 * `DevToolsActivePort` when it picked the port itself (`port=0`); with a
 * fixed `--remote-debugging-port` the HTTP endpoint is the source of truth.
 */
export async function resolveSharedEndpoint(
  userDataDir: string,
  debuggingPort: number | undefined,
): Promise<string> {
  if (debuggingPort === undefined || debuggingPort <= 0) {
    return devToolsEndpointToWsUrl(await readDevToolsEndpoint(userDataDir));
  }
  const response = await fetch(
    `http://127.0.0.1:${debuggingPort}/json/version`,
    {signal: AbortSignal.timeout(2_000)},
  );
  if (!response.ok) {
    throw new Error(
      `DevTools endpoint on port ${debuggingPort} answered ${response.status}`,
    );
  }
  const data: unknown = await response.json();
  if (
    typeof data === 'object' &&
    data !== null &&
    'webSocketDebuggerUrl' in data &&
    typeof data.webSocketDebuggerUrl === 'string'
  ) {
    return data.webSocketDebuggerUrl;
  }
  throw new Error(
    `DevTools endpoint on port ${debuggingPort} did not report a webSocketDebuggerUrl`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/**
 * The browser was spawned detached, so `pid` leads its own process group:
 * signalling the group takes Chrome's helpers and, on a virtual display,
 * xvfb-run and its Xvfb down with it instead of orphaning them.
 */
function killProcessTree(pid: number): void {
  if (os.platform() !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Not a group leader (or already gone): fall back to the process.
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone after all.
  }
}

/**
 * Serialises launches across server processes with a lock file in the profile
 * directory, so two servers that start at the same time do not both spawn a
 * Chrome for the same profile. A lock whose owner died, or that is older than
 * a minute, is treated as abandoned.
 */
export async function acquireLaunchLock(
  userDataDir: string,
  timeoutMs = LAUNCH_TIMEOUT_MS,
): Promise<() => void> {
  const lockPath = path.join(userDataDir, LAUNCH_LOCK_FILE);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
        throw err;
      }
    }
    let abandoned = false;
    try {
      const stats = fs.statSync(lockPath);
      const ownerPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      abandoned =
        Date.now() - stats.mtimeMs > LOCK_STALE_MS ||
        (!Number.isNaN(ownerPid) && !isProcessAlive(ownerPid));
    } catch {
      // Lock vanished between the open and the stat: just retry.
      continue;
    }
    if (abandoned) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else cleaned it up first.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for another chrome-devtools-mcp process to finish launching the shared browser (lock: ${lockPath}).`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

function tailOfLog(userDataDir: string, lines = 15): string {
  try {
    const content = fs.readFileSync(
      path.join(userDataDir, SHARED_BROWSER_LOG_FILE),
      'utf8',
    );
    return content.trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Spawns Chrome detached from this process and waits until it has written its
 * DevTools endpoint. The returned endpoint belongs to the new process, not to
 * a stale file from a previous run.
 */
export async function spawnSharedBrowser(
  options: SharedLaunchOptions,
  xvfbRunPath?: string,
): Promise<string> {
  const {executablePath, userDataDir, displayMode, debuggingPort} = options;
  const chromeArgs = buildSharedChromeArgs(options);

  let command = executablePath;
  let commandArgs = chromeArgs;
  const env: NodeJS.ProcessEnv = {...process.env};
  if (displayMode === 'virtual') {
    if (!xvfbRunPath) {
      throw new Error('xvfb-run is required for the virtual display mode');
    }
    command = xvfbRunPath;
    commandArgs = [
      '--auto-servernum',
      '--server-args',
      `-screen 0 ${VIRTUAL_DISPLAY_SIZE.width}x${VIRTUAL_DISPLAY_SIZE.height}x24 -ac`,
      executablePath,
      ...chromeArgs,
    ];
    // Chrome must not attach to the real session's compositor.
    delete env['WAYLAND_DISPLAY'];
    delete env['DISPLAY'];
  }

  const portPath = path.join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
  await fs.promises.rm(portPath, {force: true});

  const logFd = fs.openSync(
    path.join(userDataDir, SHARED_BROWSER_LOG_FILE),
    'w',
  );
  let child;
  try {
    logger?.('Spawning shared browser', command, commandArgs);
    child = spawn(command, commandArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(logFd);
  }

  let exitInfo: string | undefined;
  child.once('exit', (code, signal) => {
    exitInfo = `exited with ${signal ?? `code ${code}`}`;
  });
  child.once('error', err => {
    exitInfo = `could not be started: ${err.message}`;
  });
  child.unref();

  if (child.pid !== undefined) {
    writeSharedBrowserState(userDataDir, {
      launchedAt: new Date().toISOString(),
      pid: child.pid,
      displayMode,
    });
  }

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitInfo) {
      break;
    }
    try {
      return await resolveSharedEndpoint(userDataDir, debuggingPort);
    } catch {
      await delay(POLL_INTERVAL_MS);
    }
  }
  const log = tailOfLog(userDataDir);
  throw new Error(
    `The shared browser ${exitInfo ?? 'did not become ready in time'}.` +
      ` Command: ${command} ${commandArgs.join(' ')}` +
      (log ? `\nLast log lines:\n${log}` : ''),
  );
}

/**
 * Makes sure an idle watchdog (see shared-browser-watchdog.ts) is looking
 * after the shared browser, starting one when none is alive. Called by every
 * server that connects, so a watchdog that died is replaced and a browser
 * launched by an older version still gets one. Returns the watchdog's pid.
 */
export function ensureWatchdog(
  userDataDir: string,
  idleTimeoutMinutes: number,
  debuggingPort: number | undefined,
): number | undefined {
  if (idleTimeoutMinutes <= 0) {
    return undefined;
  }
  const state = readSharedBrowserState(userDataDir);
  if (!state) {
    return undefined;
  }
  if (state.watchdogPid !== undefined && isProcessAlive(state.watchdogPid)) {
    return state.watchdogPid;
  }
  const logFd = fs.openSync(path.join(userDataDir, WATCHDOG_LOG_FILE), 'a');
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        WATCHDOG_SCRIPT_PATH,
        userDataDir,
        String(idleTimeoutMinutes),
        String(debuggingPort ?? 0),
      ],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      },
    );
  } finally {
    fs.closeSync(logFd);
  }
  child.once('error', err => {
    logger?.('Could not start the shared browser watchdog', err);
  });
  child.unref();
  if (child.pid === undefined) {
    return undefined;
  }
  logger?.(`Started shared browser watchdog (pid ${child.pid})`);
  writeSharedBrowserState(userDataDir, {...state, watchdogPid: child.pid});
  return child.pid;
}

/**
 * Asks the browser to quit and waits for the process recorded in the state
 * file to go away, killing it if it refuses.
 */
export async function shutdownSharedBrowser(
  browser: Browser,
  userDataDir: string,
): Promise<void> {
  const state = readSharedBrowserState(userDataDir);
  try {
    await browser.close();
  } catch (err) {
    logger?.('Browser.close on the shared browser failed', err);
  }
  if (!state) {
    return;
  }
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(state.pid)) {
    await delay(POLL_INTERVAL_MS);
  }
  if (isProcessAlive(state.pid)) {
    logger?.('Shared browser did not exit in time, killing it');
    killProcessTree(state.pid);
  }
  await fs.promises.rm(path.join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE), {
    force: true,
  });
}
