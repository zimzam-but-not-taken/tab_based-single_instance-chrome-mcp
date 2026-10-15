#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Idle watchdog for the shared browser. Started detached next to Chrome by
 * SharedBrowser.ts; no MCP server process lives long enough to do this job.
 *
 * Connects to the shared Chrome, watches its page targets and asks Chrome to
 * quit once nothing but the blank keeper tab has been open for the idle
 * timeout. Exits as soon as the browser goes away for any other reason.
 *
 * Usage: shared-browser-watchdog.js <userDataDir> <idleTimeoutMinutes> [port]
 */

import './utils/polyfill.js';

import {countBusyPages, resolveSharedEndpoint} from './SharedBrowser.js';
import {puppeteer, type Browser} from './third_party/index.js';

const CHECK_INTERVAL_MS = 30_000;

const [userDataDir, idleMinutesRaw, portRaw] = process.argv.slice(2);
const idleMinutes = Number.parseFloat(idleMinutesRaw ?? '');
const debuggingPort = Number.parseInt(portRaw ?? '0', 10);
if (!userDataDir || Number.isNaN(idleMinutes) || idleMinutes <= 0) {
  console.error(
    'Usage: shared-browser-watchdog <userDataDir> <idleTimeoutMinutes>',
  );
  process.exit(2);
}
const idleTimeoutMs = idleMinutes * 60 * 1000;

function log(message: string): void {
  console.error(`[watchdog ${new Date().toISOString()}] ${message}`);
}

/**
 * Idle means no tab has anything loaded. Blank tabs do not count, so a
 * tool that parks a spare `about:blank` tab (browser-harness keeps one per
 * daemon) cannot keep Chrome alive forever.
 */
function isIdle(browser: Browser): boolean {
  return countBusyPages(browser) === 0;
}

async function main(): Promise<void> {
  const wsUrl = await resolveSharedEndpoint(userDataDir, debuggingPort);
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    defaultViewport: null,
  });
  log(`connected to ${wsUrl}; idle timeout ${idleMinutes} min`);

  let idleSince: number | undefined;
  let closing = false;

  const check = (): void => {
    if (closing) {
      return;
    }
    if (!isIdle(browser)) {
      if (idleSince !== undefined) {
        log('browser in use again');
      }
      idleSince = undefined;
      return;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= idleTimeoutMs) {
      closing = true;
      log('idle for too long, closing the browser');
      browser.close().catch(err => {
        log(`close failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      });
    }
  };

  browser.on('targetcreated', check);
  browser.on('targetdestroyed', check);
  browser.on('targetchanged', check);
  browser.on('disconnected', () => {
    log('browser disconnected, exiting');
    process.exit(0);
  });
  setInterval(check, CHECK_INTERVAL_MS);
  check();
}

main().catch(err => {
  console.error('watchdog failed:', err);
  process.exit(1);
});
