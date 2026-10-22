# chrome-devtools-mcp (shared-browser fork)

My fork of Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp). Upstream starts a fresh, visibly automated Chrome for every MCP instance. This fork runs **one warm Chrome that everything shares**: Claude Code over MCP, jev-ultrafast's browser-harness, etc. The browser runs on an invisible display and is set up to **look like an ordinary browser** to the sites it visits.

The MCP tools (navigation, input, snapshots, network, Lighthouse, …) are upstream's, unchanged: see the [tool reference](./docs/tool-reference.md). Everything below is what the fork changes and how I run it. This repo is never merged upstream, so these docs only cover this fork.

## How I run it

### Start the shared Chrome

```sh
chrome-devtools start --no-isolated \
  --userDataDir="$HOME/.cache/chrome-devtools-mcp/chrome-profile" \
  --proxyServer=http://127.0.0.1:8080 --proxyDomains=target.tld
chrome-devtools list_pages                  # Chrome only launches on the first tool call
curl -s http://127.0.0.1:9222/json/version  # up?
```

- `--no-isolated --userDataDir=…` are both required: without them the CLI starts a throwaway Chrome with its own profile instead of the shared one.
- `--proxyServer` is Caido. `--proxyDomains` sends **only** the target's domains (and their subdomains) through it; everything else connects directly. Repeat the flag or comma-separate.
- Everything else uses the defaults: `virtual` display (real window on an invisible Xvfb display), real GPU, port 9222.

### What connects to it

| Client          | How                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Claude Code     | MCP server `chrome-devtools-mcp` (global npm link to this repo) in `~/.claude.json`. Opens its own tabs in the shared Chrome. |
| jev-ultrafast   | browser-harness with `BU_CDP_URL=http://127.0.0.1:9222` and a `BU_NAME`.                                                      |
| ai_dev weblogin | `shared/go_pkg/browser.Connect()` → `:9222` (go-rod, with `NoDefaultDevice()` so rod doesn't override the User-Agent).        |
| anything else   | any CDP client on `http://127.0.0.1:9222`.                                                                                    |

Each client works in its own tabs and closes them when done; nobody gets a separate Chrome.

### Changing flags / restarting

**Flags only apply when Chrome launches, and whoever launches it decides them.** If Chrome is already running, `start` and MCP instances just attach, and their flags are ignored. If Chrome closed itself after being idle, the next client to need it launches it with _its_ flags. So keep the MCP config's flags in line with the `start` command above (e.g. the same `--proxyServer` / `--proxyDomains`).

To relaunch with new flags:

```sh
chrome-devtools stop    # stops the CLI daemon; Chrome keeps running
pkill -TERM -f -- "^/opt/google/chrome/chrome --user-data-dir=$HOME/.cache/chrome-devtools-mcp/chrome-profile "
chrome-devtools start --no-isolated --userDataDir=… --proxyServer=… --proxyDomains=…
chrome-devtools list_pages
```

The `pkill` pattern matches only the main Chrome process. SIGTERM lets it save the profile; `xvfb-run` then removes its Xvfb display, and the watchdog exits on its own. **Don't kill the pid in `shared-browser.json`.** In `virtual` mode that's the `xvfb-run` wrapper, and killing it leaves Chrome and its Xvfb running without it.

### Check what sites see

`shared-browser.json` in the profile shows how Chrome was launched (`displayMode`, pids). For the fingerprint itself (WebGL renderer, screen, client hints, TLS), see `ai_dev/docs/bot_detection.md`, section 7.

## What the fork changes

### One shared, warm Chrome

- The first client that needs a browser launches Chrome **detached**, so it outlives that client; later clients find it (`DevToolsActivePort` in the profile) and attach.
- The profile persists: cookies, sessions, history and third-party identifiers build up like a real person's browser. That's what makes it "warm", and sites score a browser with a history as less suspicious than a brand-new one.
- Each MCP instance only sees and controls **the tabs it opened** (plus their popups). `list_pages`, `select_page` and `close_page` never touch another instance's tabs. On exit an instance closes its tabs and disconnects; Chrome stays up.
- Tabs instead of browsers: one Chrome process, one consistent device to sites, and no start-up cost per task.
- Launches are serialised with a lock file, so two clients starting at once don't both launch Chrome.

### Lifecycle

- **Idle shutdown:** a watchdog closes Chrome once no tab has had anything loaded for `--browserIdleTimeoutMinutes` (60). Blank tabs don't count, and other CDP clients' tabs count as in use.
- **Daily restart:** after `--browserMaxAgeHours` (24) Chrome is restarted, but only while nothing is in use.
- If every tab is closed, a blank one is reopened the next time a tool needs a page.

### Looks like an ordinary browser

| Signal sites check                                                 | Upstream / headless                                                                       | This fork                                                                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `navigator.webdriver`, "controlled by automated test software" bar | `true`, bar shown                                                                         | `false`, no bar: no `--enable-automation`, `AutomationControlled` disabled                                                                                               |
| Display                                                            | headless: 800×600 screen behind a larger window, `outerWidth/Height` 0×0                  | `virtual`: real Chrome window on Xvfb, 1920×1080 screen                                                                                                                  |
| User-Agent                                                         | `HeadlessChrome/…`; covering it with `--user-agent` empties the high-entropy client hints | real Chrome UA and full client hints (no override needed in `virtual`)                                                                                                   |
| WebGL renderer                                                     | SwiftShader (software)                                                                    | the real GPU, e.g. `ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL ES 3.2)`, via `--use-angle=gl-egl`; falls back to SwiftShader without a usable GPU |
| TLS fingerprint                                                    | through an intercepting proxy, every site sees the proxy's handshake                      | with `--proxyDomains`, only the target goes through the proxy; captcha vendors and everything else see Chrome's own handshake and HTTP/2                                 |
| CLI                                                                | headless by default                                                                       | same display mode as the MCP server (`virtual`)                                                                                                                          |

`headless` and `headed` are still available (`--displayMode`). In headless the fork rewrites `HeadlessChrome` to `Chrome` and still uses the GPU, but the screen and client-hint giveaways remain, so use `virtual`.

### Proxy only the targets

With `--proxyDomains`, Chrome gets an inline PAC script (`--proxy-pac-url=data:…`) instead of `--proxy-server`: hosts equal to or under a listed domain go to the proxy (`PROXY`, `HTTPS` or `SOCKS5` to match `--proxyServer`), the rest go `DIRECT`. `example.com` covers `*.example.com` but not `notexample.com`. Without `--proxyDomains`, everything goes through the proxy as upstream does. The list is fixed at launch (Chrome doesn't load PAC files from `file://`, and only rechecks a PAC URL rarely), so restart Chrome to change it.

## Options added or changed by the fork

| Flag                          | Default   |                                                                                                                                                                             |
| ----------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--sharedBrowser`             | `true`    | Share one Chrome. `--no-shared-browser` gives each instance its own Chrome (upstream behaviour). Bypassed by `--isolated`, `--browserUrl`, `--wsEndpoint`, `--autoConnect`. |
| `--sharedBrowserPort`         | `9222`    | DevTools port of the shared Chrome (`0` = random).                                                                                                                          |
| `--browserIdleTimeoutMinutes` | `60`      | Close Chrome after this long with no tab in use (`0` = never).                                                                                                              |
| `--browserMaxAgeHours`        | `24`      | Restart Chrome once older than this, while idle (`0` = never).                                                                                                              |
| `--displayMode`               | `virtual` | `virtual` (Xvfb; falls back to `headless` without `xvfb-run` or off Linux), `headless`, `headed`. `--headless` = `--displayMode=headless`.                                  |
| `--gpu`                       | `true`    | Use the real GPU for WebGL in `virtual`/`headless` on Linux. `--no-gpu` keeps SwiftShader.                                                                                  |
| `--proxyDomains`              |           | Only these domains (and subdomains) use `--proxyServer`.                                                                                                                    |
| CLI `--headless`              | `false`   | Upstream's CLI defaults to headless; here it follows `--displayMode`.                                                                                                       |

Every option, upstream's included, is listed in [docs/configuration.md](./docs/configuration.md) (generated from the code).

## Install / update

The global `chrome-devtools` and `chrome-devtools-mcp` commands are an npm link to this checkout (`~/.npm-global/lib/node_modules/chrome-devtools-mcp → ~/.tools/chrome-devtools-mcp-fork`), so updating is just:

```sh
cd ~/.tools/chrome-devtools-mcp-fork && npm run build
```

then restart the daemon (`chrome-devtools start …`) and, for launch-flag changes, Chrome itself (see above).

**Ignore the "Update available … `npm install -g chrome-devtools-mcp@latest`" notice.** Running that replaces the link to this fork with Google's package. Set `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1` to silence it.

Requirements: Node.js LTS, Chrome stable, `xvfb-run` (`pacman -S xorg-server-xvfb`), and read/write access to `/dev/dri/renderD*` for the GPU.

## Files

In the profile directory, `~/.cache/chrome-devtools-mcp/chrome-profile`:

- `shared-browser.json`: launch time, display mode, Chrome's (in `virtual`: `xvfb-run`'s) pid, watchdog pid
- `shared-browser.log`: Chrome's stderr
- `shared-browser-watchdog.log`: idle watchdog
- `shared-browser.lock`: held while a client launches Chrome

## Troubleshooting

- **Chrome came up headless, or without `--proxyDomains`:** it was launched by a client with different flags (an older build's CLI defaulted to headless, and the MCP config may lack `--proxyDomains`). Check `shared-browser.json` and `ps`, then relaunch as above.
- **New flags have no effect:** Chrome was already running. Relaunch it.
- **WebGL still says SwiftShader:** `--no-gpu` was passed, or Chrome can't open `/dev/dri/renderD*`. Check `ls -l /dev/dri`.
- **A stray Chrome or Xvfb after killing things by hand:** close Chrome with the `pkill` above; leftover `Xvfb :N` processes whose display no Chrome uses can be killed.
- **CLI hangs:** `chrome-devtools stop`, then start again. For logs: `NODE_DEBUG=* chrome-devtools start --logFile=/tmp/cdt.log …`.

## Development

```sh
npm run build
npm run test                                # build + all tests
node --test build/tests/SharedBrowser.test.js   # one file (after build)
npm run gen                                 # regenerate CLI + docs/configuration.md + tool references
npm run format
```

- Fork code: `src/SharedBrowser.ts` (launch args, PAC/GPU flags, finding and retiring the shared Chrome), `src/shared-browser-watchdog.ts` (idle shutdown), `src/BrowserManager.ts` (shared vs. private launch, display modes), `src/McpContext.ts` (per-instance tab ownership), `src/config/browser-options.ts` and `src/config/mcp-options.ts` (options, CLI defaults).
- `tests/browser.test.ts` has 5 failures that also fail without the fork's changes (they launch real Chrome).

## Kept from upstream

- Usage statistics are on by default: `--no-usage-statistics` or `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` to opt out.
- The server exposes everything in the browser to the MCP client.

Apache-2.0, see [LICENSE](./LICENSE).
