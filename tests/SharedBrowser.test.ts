/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  acquireLaunchLock,
  buildGpuArgs,
  buildProxyArgs,
  buildRegularUserAgent,
  buildSharedChromeArgs,
  countBusyPages,
  devToolsEndpointToWsUrl,
  isSharedBrowserStale,
  parseChromeMajorVersion,
  readDevToolsEndpoint,
  readSharedBrowserState,
  resolveDisplayMode,
  writeSharedBrowserState,
} from '../src/SharedBrowser.js';
import {TargetType} from '../src/third_party/index.js';

import {
  createMockPuppeteerBrowser,
  createMockPuppeteerTarget,
} from './mocks.js';
import {createTempDir} from './utils.js';

describe('SharedBrowser', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('resolveDisplayMode', () => {
    it('keeps headless and headed as requested', () => {
      assert.deepStrictEqual(resolveDisplayMode('headless', 'linux', '/x'), {
        mode: 'headless',
      });
      assert.deepStrictEqual(resolveDisplayMode('headed', 'linux', undefined), {
        mode: 'headed',
      });
    });

    it('uses xvfb-run for a virtual display on Linux', () => {
      assert.deepStrictEqual(
        resolveDisplayMode('virtual', 'linux', '/usr/bin/xvfb-run'),
        {mode: 'virtual', xvfbRunPath: '/usr/bin/xvfb-run'},
      );
    });

    it('falls back to headless without xvfb-run or on other platforms', () => {
      const noXvfb = resolveDisplayMode('virtual', 'linux', undefined);
      assert.strictEqual(noXvfb.mode, 'headless');
      assert.match(noXvfb.reason ?? '', /xvfb-run was not found/);

      const mac = resolveDisplayMode('virtual', 'darwin', '/usr/bin/xvfb-run');
      assert.strictEqual(mac.mode, 'headless');
      assert.match(mac.reason ?? '', /not available on darwin/);
    });
  });

  describe('user agent', () => {
    it('parses the major version from chrome --version output', () => {
      assert.strictEqual(
        parseChromeMajorVersion('Google Chrome 155.0.8059.39 \n'),
        155,
      );
      assert.strictEqual(parseChromeMajorVersion('garbage'), undefined);
    });

    it('builds the user agent of a regular Chrome', () => {
      assert.strictEqual(
        buildRegularUserAgent(155, 'linux'),
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      );
      assert.match(buildRegularUserAgent(155, 'darwin'), /Macintosh/);
      assert.match(buildRegularUserAgent(155, 'win32'), /Windows NT 10.0/);
    });
  });

  describe('buildGpuArgs', () => {
    it('puts WebGL on the GPU in virtual and headless mode on Linux', () => {
      for (const mode of ['virtual', 'headless'] as const) {
        assert.deepStrictEqual(buildGpuArgs(mode, true, 'linux'), [
          '--use-angle=gl-egl',
        ]);
      }
    });

    it('leaves headed, other platforms and --no-gpu alone', () => {
      assert.deepStrictEqual(buildGpuArgs('headed', true, 'linux'), []);
      assert.deepStrictEqual(buildGpuArgs('virtual', true, 'darwin'), []);
      assert.deepStrictEqual(buildGpuArgs('virtual', false, 'linux'), []);
    });
  });

  describe('buildProxyArgs', () => {
    // Runs the generated PAC the way Chrome does, with its dnsDomainIs helper.
    function route(args: string[], host: string): string {
      const b64 = args[0].split('base64,')[1];
      const pac = Buffer.from(b64, 'base64').toString();
      const find = new Function(
        'dnsDomainIs',
        `${pac}; return FindProxyForURL;`,
      )((h: string, d: string) => h.endsWith(d));
      return find(`https://${host}/`, host);
    }

    it('proxies everything without a domain list', () => {
      assert.deepStrictEqual(buildProxyArgs('http://127.0.0.1:8080'), [
        '--proxy-server=http://127.0.0.1:8080',
      ]);
      assert.deepStrictEqual(buildProxyArgs(undefined, ['example.com']), []);
    });

    it('proxies only the listed domains and their subdomains', () => {
      const args = buildProxyArgs('http://127.0.0.1:8080', [
        'Example.com',
        '*.target.org,other.net',
      ]);
      assert.strictEqual(args.length, 1);
      assert.ok(args[0].startsWith('--proxy-pac-url=data:'));
      for (const host of [
        'example.com',
        'a.b.example.com',
        'target.org',
        'x.other.net',
      ]) {
        assert.strictEqual(route(args, host), 'PROXY 127.0.0.1:8080', host);
      }
      for (const host of [
        'notexample.com',
        'example.com.evil.io',
        'client-api.arkoselabs.com',
      ]) {
        assert.strictEqual(route(args, host), 'DIRECT', host);
      }
    });

    it('maps the proxy scheme to the PAC keyword', () => {
      const args = buildProxyArgs('socks5://127.0.0.1:1080', ['example.com']);
      assert.strictEqual(route(args, 'example.com'), 'SOCKS5 127.0.0.1:1080');
    });
  });

  describe('buildSharedChromeArgs', () => {
    it('never passes automation flags', () => {
      const args = buildSharedChromeArgs({
        userDataDir: '/tmp/profile',
        displayMode: 'headed',
      });
      assert.ok(!args.includes('--enable-automation'));
      assert.ok(!args.some(arg => arg.startsWith('--headless')));
      assert.ok(!args.some(arg => arg.startsWith('--disable-features')));
      assert.ok(args.includes('--user-data-dir=/tmp/profile'));
      assert.ok(args.includes('--remote-debugging-port=0'));
      assert.ok(
        buildSharedChromeArgs({
          userDataDir: '/tmp/profile',
          displayMode: 'headed',
          debuggingPort: 9222,
        }).includes('--remote-debugging-port=9222'),
      );
      assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
      assert.strictEqual(args.at(-1), 'about:blank');
    });

    it('pins Chrome to X11 on a virtual display', () => {
      const args = buildSharedChromeArgs({
        userDataDir: '/tmp/profile',
        displayMode: 'virtual',
      });
      assert.ok(args.includes('--ozone-platform=x11'));
      assert.ok(!args.some(arg => arg.startsWith('--headless')));
    });

    it('runs new headless with the regular user agent, proxy and extra args', () => {
      const args = buildSharedChromeArgs({
        userDataDir: '/tmp/profile',
        displayMode: 'headless',
        userAgent: 'UA',
        proxyServer: 'http://localhost:8080',
        extraArgs: ['--custom-arg', 'https://example.com'],
      });
      assert.ok(args.includes('--headless=new'));
      assert.ok(args.includes('--user-agent=UA'));
      assert.ok(args.includes('--proxy-server=http://localhost:8080'));
      assert.ok(args.includes('--custom-arg'));
      assert.strictEqual(args.at(-1), 'https://example.com');
      assert.ok(!args.includes('about:blank'));
    });
  });

  describe('state file', () => {
    it('round-trips and reports staleness by age', () => {
      using dir = createTempDir('shared-browser-test-');
      assert.strictEqual(readSharedBrowserState(dir.path), undefined);
      const launchedAt = new Date('2026-10-12T00:00:00Z');
      writeSharedBrowserState(dir.path, {
        launchedAt: launchedAt.toISOString(),
        pid: 1234,
        displayMode: 'virtual',
      });
      const state = readSharedBrowserState(dir.path);
      assert.deepStrictEqual(state, {
        launchedAt: launchedAt.toISOString(),
        pid: 1234,
        displayMode: 'virtual',
      });
      const oneHourLater = launchedAt.getTime() + 60 * 60 * 1000;
      const twoDaysLater = launchedAt.getTime() + 48 * 60 * 60 * 1000;
      assert.strictEqual(isSharedBrowserStale(state, 24, oneHourLater), false);
      assert.strictEqual(isSharedBrowserStale(state, 24, twoDaysLater), true);
      assert.strictEqual(isSharedBrowserStale(state, 0, twoDaysLater), false);
      assert.strictEqual(
        isSharedBrowserStale(undefined, 24, twoDaysLater),
        false,
      );
    });

    it('ignores a corrupt state file', () => {
      using dir = createTempDir('shared-browser-test-');
      fs.writeFileSync(
        path.join(dir.path, 'shared-browser.json'),
        '{"pid":"x"}',
      );
      assert.strictEqual(readSharedBrowserState(dir.path), undefined);
    });
  });

  describe('DevToolsActivePort', () => {
    it('reads the endpoint Chrome wrote', async () => {
      using dir = createTempDir('shared-browser-test-');
      fs.writeFileSync(
        path.join(dir.path, 'DevToolsActivePort'),
        '9222\n/devtools/browser/abc\n',
      );
      const endpoint = await readDevToolsEndpoint(dir.path);
      assert.deepStrictEqual(endpoint, {
        port: 9222,
        path: '/devtools/browser/abc',
      });
      assert.strictEqual(
        devToolsEndpointToWsUrl(endpoint),
        'ws://127.0.0.1:9222/devtools/browser/abc',
      );
    });

    it('rejects a missing or malformed file', async () => {
      using dir = createTempDir('shared-browser-test-');
      await assert.rejects(readDevToolsEndpoint(dir.path));
      fs.writeFileSync(path.join(dir.path, 'DevToolsActivePort'), 'nope\n');
      await assert.rejects(readDevToolsEndpoint(dir.path), /Invalid/);
    });
  });

  describe('countBusyPages', () => {
    it('counts only page targets that left the blank page', () => {
      const browser = createMockPuppeteerBrowser();
      const blank = createMockPuppeteerTarget({url: 'about:blank'});
      blank.type.returns(TargetType.PAGE);
      const newTab = createMockPuppeteerTarget({url: 'chrome://newtab/'});
      newTab.type.returns(TargetType.PAGE);
      const busy = createMockPuppeteerTarget({url: 'https://example.com'});
      busy.type.returns(TargetType.PAGE);
      const worker = createMockPuppeteerTarget({url: 'https://example.com/sw'});
      worker.type.returns(TargetType.SERVICE_WORKER);
      browser.targets.returns([blank, newTab, busy, worker]);

      assert.strictEqual(countBusyPages(browser), 1);
    });
  });

  describe('acquireLaunchLock', () => {
    it('is exclusive until released and reclaims a dead owner', async () => {
      using dir = createTempDir('shared-browser-test-');
      const release = await acquireLaunchLock(dir.path);
      await assert.rejects(acquireLaunchLock(dir.path, 300), /Timed out/);
      release();

      // A lock left behind by a process that no longer exists.
      fs.writeFileSync(path.join(dir.path, 'shared-browser.lock'), '999999999');
      const releaseAgain = await acquireLaunchLock(dir.path, 300);
      releaseAgain();
      assert.ok(!fs.existsSync(path.join(dir.path, 'shared-browser.lock')));
    });
  });
});
