/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {YargsOptions} from '../third_party/index.js';

export const browserOptions = {
  autoConnect: {
    type: 'boolean',
    description:
      'If specified, automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param (default channel is stable). Requires the remote debugging server to be started in the Chrome instance via chrome://inspect/#remote-debugging.',
    default: false,
  },
  browserUrl: {
    type: 'string',
    description:
      'Connect to a running, debuggable Chrome instance (e.g. `http://127.0.0.1:9222`). For more details see: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance.',
    alias: 'u',
    coerce: (url: string | undefined) => {
      if (!url) {
        return;
      }
      try {
        new URL(url);
      } catch {
        throw new Error(`Provided browserUrl ${url} is not valid URL.`);
      }
      return url;
    },
  },
  wsEndpoint: {
    type: 'string',
    description:
      'WebSocket endpoint to connect to a running Chrome instance (e.g., ws://127.0.0.1:9222/devtools/browser/<id>). Alternative to --browserUrl.',
    alias: 'w',
    coerce: (url: string | undefined) => {
      if (!url) {
        return;
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
          throw new Error(
            `Provided wsEndpoint ${url} must use ws:// or wss:// protocol.`,
          );
        }
        return url;
      } catch (error) {
        if ((error as Error).message.includes('ws://')) {
          throw error;
        }
        throw new Error(`Provided wsEndpoint ${url} is not valid URL.`);
      }
    },
  },
  wsHeaders: {
    type: 'string',
    description:
      'Custom headers for WebSocket connection in JSON format (e.g., \'{"Authorization":"Bearer token"}\'). Only works with --wsEndpoint.',
    coerce: (val: string | undefined) => {
      if (!val) {
        return;
      }
      try {
        const parsed = JSON.parse(val);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Headers must be a JSON object');
        }
        return parsed as Record<string, string>;
      } catch (error) {
        throw new Error(
          `Invalid JSON for wsHeaders: ${(error as Error).message}`,
        );
      }
    },
  },
  sharedBrowser: {
    type: 'boolean',
    description:
      'Share one long-lived Chrome between all chrome-devtools-mcp instances using the same profile. The first instance launches Chrome detached, every instance works in its own tabs and closes them on shutdown, and Chrome keeps running (warm) for the next one. Ignored with --isolated, --browserUrl, --wsEndpoint or --autoConnect. Use --no-shared-browser to launch and close a private Chrome per instance.',
    default: true,
  },
  sharedBrowserPort: {
    type: 'number',
    description:
      'Local port the shared browser listens on for DevTools (CDP) connections, so other tools such as browser-use can attach to the same Chrome at http://127.0.0.1:<port>. 0 picks a random free port.',
    default: 9222,
  },
  browserIdleTimeoutMinutes: {
    type: 'number',
    description:
      'Shut the shared browser down once no instance has had a tab open for this many minutes. A watchdog process started next to Chrome does this, so it works after every instance has exited; the next instance simply launches Chrome again. 0 keeps Chrome running forever.',
    default: 60,
  },
  browserMaxAgeHours: {
    type: 'number',
    description:
      'Restart the shared browser once it is older than this many hours. The restart happens the next time an instance connects or disconnects while no tab is in use, so nobody is interrupted. 0 disables restarts.',
    default: 24,
  },
  displayMode: {
    type: 'string',
    description:
      'Where the browser window goes. `virtual`: a real window on an invisible Xvfb display (nothing appears on your desktop and sites see a normal browser; needs xvfb-run, falls back to headless). `headless`: no window, with the user agent fixed up to look like regular Chrome. `headed`: a window on your desktop.',
    choices: ['virtual', 'headless', 'headed'] as const,
    default: 'virtual' as const,
  },
  headless: {
    type: 'boolean',
    description:
      'Whether to run in headless (no UI) mode. Shorthand for --display-mode=headless.',
    default: false,
  },
  executablePath: {
    type: 'string',
    description: 'Path to custom Chrome executable.',
    alias: 'e',
  },
  isolated: {
    type: 'boolean',
    description:
      'If specified, creates a temporary user-data-dir that is automatically cleaned up after the browser is closed. Defaults to false.',
    default: false,
  },
  userDataDir: {
    type: 'string',
    description:
      'Path to the user data directory for Chrome. Default is $HOME/.cache/chrome-devtools-mcp/chrome-profile$CHANNEL_SUFFIX_IF_NON_STABLE',
  },
  channel: {
    type: 'string',
    description:
      'Specify a different Chrome channel that should be used. The default is the stable channel version.',
    choices: ['canary', 'dev', 'beta', 'stable'] as const,
    default: 'stable' as const,
  },
  proxyServer: {
    type: 'string',
    description: `Proxy server configuration for Chrome passed as --proxy-server when launching the browser. See https://www.chromium.org/developers/design-documents/network-settings/ for details.`,
  },
  gpu: {
    type: 'boolean',
    description:
      "Render with the machine's GPU (ANGLE over EGL) in `virtual` and `headless` mode on Linux, so WebGL reports the real graphics card instead of SwiftShader, Chrome's software renderer that sites read as a sign of automation. Falls back to SwiftShader where there is no usable GPU. `--no-gpu` keeps SwiftShader.",
    default: true,
  },
  proxyDomains: {
    type: 'array',
    string: true,
    description:
      'Send only these domains (and their subdomains) through --proxyServer; everything else connects directly. For example `--proxyDomains=example.com --proxyDomains=example.org`. Without it, all traffic uses the proxy.',
  },
  chromeArg: {
    type: 'array',
    string: true,
    describe:
      'Additional arguments for Chrome. Only applies when Chrome is launched by chrome-devtools-mcp.',
  },
  ignoreDefaultChromeArg: {
    type: 'array',
    string: true,
    describe:
      'Explicitly disable default arguments for Chrome. Only applies when Chrome is launched by chrome-devtools-mcp.',
  },
} satisfies Record<string, YargsOptions>;

export function getBrowserOptions(): typeof browserOptions {
  return browserOptions;
}
