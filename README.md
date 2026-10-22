# chrome-devtools-mcp (shared-browser fork)

A fork of Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) that changes how the browser is run. Upstream starts a new Chrome for every server instance, shows it on your desktop and marks it as automated. This fork keeps **one warm Chrome that every instance shares**, runs it **on an invisible display** and makes it **look like a normal browser** to the sites it visits.

The tools themselves (navigation, input, snapshots, network, performance, Lighthouse, …) are unchanged. See the [Tool Reference](./docs/tool-reference.md).

## What's different from upstream

### One shared, long-lived Chrome

- The first server instance launches Chrome **detached**, so it outlives that instance. Later instances find it and connect to it instead of starting their own.
- Each instance only sees and controls **the tabs it opened** (plus popups those tabs spawn). `list_pages`, `select_page` and `close_page` never touch another instance's tabs.
- When an instance exits it closes its own tabs and disconnects. Chrome stays running with a warm profile, so the next instance starts immediately.
- If every tab is closed, a blank one is reopened the next time a tool needs a page. `close_page` can therefore close the last page, which upstream refuses.
- Two instances starting at the same moment won't both launch Chrome: launches are serialised with a lock file in the profile directory.

### Lifecycle

- **Idle shutdown:** a small watchdog process started next to Chrome closes it once no tab has had anything loaded for `--browserIdleTimeoutMinutes` (default 60). Blank tabs don't count. The next instance simply launches Chrome again.
- **Daily restart:** once Chrome is older than `--browserMaxAgeHours` (default 24) it is restarted, but only while no tab of any instance is in use, so nobody's work is interrupted.

### No window on your desktop

`--displayMode` decides where the browser window goes:

| Mode                | What you get                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `virtual` (default) | A real, headed Chrome on an invisible Xvfb display. Nothing pops up and sites see an ordinary browser. Falls back to `headless` if Xvfb isn't installed, or on macOS/Windows. |
| `headless`          | Chrome's new headless mode. In the shared browser the `HeadlessChrome` user agent is rewritten to the regular `Chrome/…` one.                                                 |
| `headed`            | A normal window on your desktop.                                                                                                                                              |

This applies both to the shared browser and to a private one (`--no-shared-browser`), and to the `chrome-devtools` CLI too: unlike upstream, it isn't headless by default. `--headless` still works as a shorthand for `--displayMode=headless`.

### Looks like a normal browser

Chrome is launched without `--enable-automation` and Puppeteer's other test-only switches, and with `AutomationControlled` disabled. So `navigator.webdriver` is `false` and the "Chrome is being controlled by automated test software" bar never appears.

Without a real display Chrome normally falls back to SwiftShader, its software renderer, and pages can read that from WebGL (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))`), a well-known automation tell. On Linux the fork renders with the machine's GPU in `virtual` and `headless` mode (`--use-angle=gl-egl`, which reaches the GPU through `/dev/dri/renderD*` without needing the display), so WebGL reports the real card, e.g. `ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL ES 3.2)`. Where there is no usable GPU, WebGL still falls back to SwiftShader. `--no-gpu` turns this off.

In `virtual` mode the page also sees a normal screen (1920x1080), a real window size and full user-agent client hints. In `headless` mode the screen is 800x600, the window reports 0x0, and the `--user-agent` override that hides `HeadlessChrome` empties the high-entropy client hints, so prefer `virtual`.

### Proxy only your targets

`--proxyDomains` limits `--proxyServer` to the listed domains and their subdomains; everything else connects directly. For example, to record a target in an intercepting proxy without routing third-party traffic (captcha vendors, analytics, Google) through it:

```sh
--proxyServer=http://127.0.0.1:8080 --proxyDomains=example.com --proxyDomains=example.org
```

`example.com` covers `example.com` and `*.example.com`, but not `notexample.com`. Under the hood Chrome gets an inline PAC script instead of `--proxy-server`. The list is fixed when Chrome starts; restart the shared browser to change it.

### Other CDP tools can share the same Chrome

The shared Chrome listens on `http://127.0.0.1:9222` (`--sharedBrowserPort`), so other CDP clients can attach to the same browser and profile. For example, browser-use's browser-harness (used by jev-ultrafast) works with `BU_CDP_URL=http://127.0.0.1:9222` and a `BU_NAME`. Their tabs count as "in use" for the idle shutdown and the daily restart too.

## New options

| Flag                          | Default   | Description                                                                                                                                                                                                      |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--sharedBrowser`             | `true`    | Share one Chrome between instances. `--no-shared-browser` gives each instance its own Chrome, closed on exit (upstream behaviour). Bypassed by `--isolated`, `--browserUrl`, `--wsEndpoint` and `--autoConnect`. |
| `--sharedBrowserPort`         | `9222`    | DevTools port of the shared Chrome. `0` picks a random free port.                                                                                                                                                |
| `--browserIdleTimeoutMinutes` | `60`      | Close the shared Chrome after this long with no tab in use. `0` keeps it running forever.                                                                                                                        |
| `--browserMaxAgeHours`        | `24`      | Restart the shared Chrome once it is older than this, while idle. `0` disables restarts.                                                                                                                         |
| `--displayMode`               | `virtual` | `virtual`, `headless` or `headed`, see above.                                                                                                                                                                    |
| `--gpu`                       | `true`    | Render WebGL with the real GPU instead of SwiftShader in `virtual`/`headless` mode on Linux. `--no-gpu` keeps SwiftShader.                                                                                       |
| `--proxyDomains`              |           | Send only these domains (and subdomains) through `--proxyServer`; the rest goes direct. Repeat the flag or comma-separate.                                                                                       |

All other upstream options still work. See the [Configuration Guide](./docs/configuration.md#shared-browser) for the full list and more detail on the shared browser.

## Install and run

Requirements: Node.js LTS, Chrome stable and, for the default `virtual` mode on Linux, Xvfb (`pacman -S xorg-server-xvfb` or `apt install xvfb`).

```sh
git clone git@github.com:voidclick-labs/chrome-devtools-mcp-fork.git
cd chrome-devtools-mcp-fork
npm ci
npm run build
```

Register the built server with your MCP client, e.g. Claude Code:

```sh
claude mcp add --scope user chrome-devtools -- node "$PWD/build/src/bin/chrome-devtools-mcp.js"
```

or in a JSON client config:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": [
        "/path/to/chrome-devtools-mcp-fork/build/src/bin/chrome-devtools-mcp.js"
      ]
    }
  }
}
```

If you also have the official chrome-devtools-mcp plugin or server installed, disable it to avoid getting every tool twice.

After pulling changes, run `npm run build` again.

### Starting the shared Chrome without an MCP client

The bundled `chrome-devtools` CLI runs the same server as a background daemon, so you can bring the shared Chrome up from a terminal, for example for jev-ultrafast or when your MCP client is down:

```sh
chrome-devtools start --no-isolated \
  --userDataDir="$HOME/.cache/chrome-devtools-mcp/chrome-profile" \
  --proxyServer=http://127.0.0.1:8080 --proxyDomains=example.com   # optional
chrome-devtools list_pages   # Chrome only launches on the first tool call
curl http://127.0.0.1:9222/json/version
```

Both flags are needed. In CLI mode `--isolated` is on by default, which bypasses the shared browser and gives you a throwaway Puppeteer Chrome with a temporary profile and the automation switches. Without `--userDataDir` the CLI also uses its own `~/.cache/chrome-devtools-mcp-cli` profile instead of the one MCP instances share. Pass any other server flags (e.g. `--proxyServer`) the same way you would in your MCP client config. The CLI runs in `--displayMode=virtual` with the GPU like the MCP server; upstream's CLI is headless by default, so a Chrome started by an older build of this fork may still be headless (`shared-browser.json` shows the `displayMode`). The shared Chrome keeps the flags it was launched with until it restarts, so stop it to apply new ones.

`chrome-devtools status` and `chrome-devtools stop` manage the daemon. Stopping it leaves Chrome running; it closes itself after the idle timeout as usual. If the `chrome-devtools` command isn't on your `PATH`, run `node build/src/bin/chrome-devtools.js` instead.

## Where things live

Everything is in the profile directory, `~/.cache/chrome-devtools-mcp/chrome-profile` by default:

- `shared-browser.json`: when the shared Chrome was launched, its pid and its watchdog's pid
- `shared-browser.log`: Chrome's stderr
- `shared-browser-watchdog.log`: the idle watchdog's log
- `shared-browser.lock`: held briefly while an instance launches Chrome

To check whether the shared Chrome is up: `curl http://127.0.0.1:9222/json/version`.

## Development

```sh
npm run build                         # tsc + post-build
npm run test                          # build and run all tests
npm run test tests/SharedBrowser.test.ts   # a single test file
npm run format                        # eslint --fix + prettier
```

The fork's code is mainly in `src/SharedBrowser.ts` (launching, finding and retiring the shared Chrome), `src/shared-browser-watchdog.ts` (idle shutdown), `src/BrowserManager.ts` (shared vs. private launch, display modes) and `src/McpContext.ts` (per-instance tab ownership).

## Kept from upstream

- **Usage statistics:** Google's usage statistics collection is still enabled by default. Opt out with `--no-usage-statistics` or by setting `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS`.
- **Update checks:** the server still checks npm for new upstream versions. Disable that with `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`.
- **Disclaimer:** the server exposes the browser's content to your MCP client, so don't use it with sites or data you don't want the agent to see.

Other docs from upstream still apply: [advanced usage](./docs/advanced-usage.md), [client configurations](./docs/client-configurations.md), [CLI](./docs/cli.md), [troubleshooting](./docs/troubleshooting.md).

## License

Apache-2.0, same as upstream. See [LICENSE](./LICENSE).
