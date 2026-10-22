# Configuration

Every server option, upstream's and the fork's. The list between the markers is generated from `src/config/*-options.ts` by `npm run gen`; don't edit it by hand. What the fork's options do, and how I use them, is in the [README](../README.md).

<!-- BEGIN AUTO GENERATED OPTIONS -->

- **`--categoryInput`/ `--category-input`**
  Set to false to exclude tools related to input.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryNavigation`/ `--category-navigation`**
  Set to false to exclude tools related to navigation.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryEmulation`/ `--category-emulation`**
  Set to false to exclude tools related to emulation.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryPerformance`/ `--category-performance`**
  Set to false to exclude tools related to performance.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryNetwork`/ `--category-network`**
  Set to false to exclude tools related to network.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryDebugging`/ `--category-debugging`**
  Set to false to exclude tools related to debugging.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryExtensions`/ `--category-extensions`**
  Set to true to include tools related to extensions.
  - **Type:** boolean
  - **Default:** `false`

- **`--categoryExperimentalThirdParty`/ `--category-experimental-third-party`**
  Set to true to enable third-party developer tools exposed by the inspected page itself (via WebMCP or devtoolstooldiscovery)
  - **Type:** boolean
  - **Default:** `false`

- **`--categoryMemory`/ `--category-memory`**
  Set to false to exclude tools related to memory.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryExperimentalWebmcp`/ `--category-experimental-webmcp`**
  Set to true to enable WebMCP tools (excluding debugging tools, which are exposed under the third-party developer tools category). Requires Chrome 150+ with the following flag: `--enable-features=WebMCP`
  - **Type:** boolean
  - **Default:** `false`

- **`--categoryPwa`/ `--category-pwa`**
  Set to true to include tools for automating Progressive Web Apps (install, launch, uninstall, and OS state). This feature is only supported with a pipe connection; autoConnect, browserUrl, and wsEndpoint are not supported.
  - **Type:** boolean
  - **Default:** `false`

- **`--autoConnect`/ `--auto-connect`**
  If specified, automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param (default channel is stable). Requires the remote debugging server to be started in the Chrome instance via chrome://inspect/#remote-debugging.
  - **Type:** boolean
  - **Default:** `false`

- **`--browserUrl`/ `--browser-url`, `-u`**
  Connect to a running, debuggable Chrome instance (e.g. `http://127.0.0.1:9222`). For more details see: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance.
  - **Type:** string

- **`--wsEndpoint`/ `--ws-endpoint`, `-w`**
  WebSocket endpoint to connect to a running Chrome instance (e.g., ws://127.0.0.1:9222/devtools/browser/<id>). Alternative to --browserUrl.
  - **Type:** string

- **`--wsHeaders`/ `--ws-headers`**
  Custom headers for WebSocket connection in JSON format (e.g., '{"Authorization":"Bearer token"}'). Only works with --wsEndpoint.
  - **Type:** string

- **`--sharedBrowser`/ `--shared-browser`**
  Share one long-lived Chrome between all chrome-devtools-mcp instances using the same profile. The first instance launches Chrome detached, every instance works in its own tabs and closes them on shutdown, and Chrome keeps running (warm) for the next one. Ignored with --isolated, --browserUrl, --wsEndpoint or --autoConnect. Use --no-shared-browser to launch and close a private Chrome per instance.
  - **Type:** boolean
  - **Default:** `true`

- **`--sharedBrowserPort`/ `--shared-browser-port`**
  Local port the shared browser listens on for DevTools (CDP) connections, so other tools such as browser-use can attach to the same Chrome at http://127.0.0.1:<port>. 0 picks a random free port.
  - **Type:** number
  - **Default:** `9222`

- **`--browserIdleTimeoutMinutes`/ `--browser-idle-timeout-minutes`**
  Shut the shared browser down once no instance has had a tab open for this many minutes. A watchdog process started next to Chrome does this, so it works after every instance has exited; the next instance simply launches Chrome again. 0 keeps Chrome running forever.
  - **Type:** number
  - **Default:** `60`

- **`--browserMaxAgeHours`/ `--browser-max-age-hours`**
  Restart the shared browser once it is older than this many hours. The restart happens the next time an instance connects or disconnects while no tab is in use, so nobody is interrupted. 0 disables restarts.
  - **Type:** number
  - **Default:** `24`

- **`--displayMode`/ `--display-mode`**
  Where the browser window goes. `virtual`: a real window on an invisible Xvfb display (nothing appears on your desktop and sites see a normal browser; needs xvfb-run, falls back to headless). `headless`: no window, with the user agent fixed up to look like regular Chrome. `headed`: a window on your desktop.
  - **Type:** string
  - **Choices:** `virtual`, `headless`, `headed`
  - **Default:** `virtual`

- **`--headless`**
  Whether to run in headless (no UI) mode. Shorthand for --display-mode=headless.
  - **Type:** boolean
  - **Default:** `false`

- **`--executablePath`/ `--executable-path`, `-e`**
  Path to custom Chrome executable.
  - **Type:** string

- **`--isolated`**
  If specified, creates a temporary user-data-dir that is automatically cleaned up after the browser is closed. Defaults to false.
  - **Type:** boolean
  - **Default:** `false`

- **`--userDataDir`/ `--user-data-dir`**
  Path to the user data directory for Chrome. Default is $HOME/.cache/chrome-devtools-mcp/chrome-profile$CHANNEL_SUFFIX_IF_NON_STABLE
  - **Type:** string

- **`--channel`**
  Specify a different Chrome channel that should be used. The default is the stable channel version.
  - **Type:** string
  - **Choices:** `canary`, `dev`, `beta`, `stable`
  - **Default:** `stable`

- **`--proxyServer`/ `--proxy-server`**
  Proxy server configuration for Chrome passed as --proxy-server when launching the browser. See https://www.chromium.org/developers/design-documents/network-settings/ for details.
  - **Type:** string

- **`--gpu`**
  Render with the machine's GPU (ANGLE over EGL) in `virtual` and `headless` mode on Linux, so WebGL reports the real graphics card instead of SwiftShader, Chrome's software renderer that sites read as a sign of automation. Falls back to SwiftShader where there is no usable GPU. `--no-gpu` keeps SwiftShader.
  - **Type:** boolean
  - **Default:** `true`

- **`--proxyDomains`/ `--proxy-domains`**
  Send only these domains (and their subdomains) through --proxyServer; everything else connects directly. For example `--proxyDomains=example.com --proxyDomains=example.org`. Without it, all traffic uses the proxy.
  - **Type:** array

- **`--chromeArg`/ `--chrome-arg`**
  Additional arguments for Chrome. Only applies when Chrome is launched by chrome-devtools-mcp.
  - **Type:** array

- **`--ignoreDefaultChromeArg`/ `--ignore-default-chrome-arg`**
  Explicitly disable default arguments for Chrome. Only applies when Chrome is launched by chrome-devtools-mcp.
  - **Type:** array

- **`--viewport`**
  Initial viewport size for the Chrome instances started by the server. For example, `1280x720`. In headless mode, max size is 3840x2160px.
  - **Type:** string

- **`--acceptInsecureCerts`/ `--accept-insecure-certs`**
  If enabled, ignores errors relative to self-signed and expired certificates. Use with caution.
  - **Type:** boolean
  - **Default:** `false`

- **`--blockedUrlPattern`/ `--blocked-url-pattern`**
  Restricts browser's network access by blocking specified URL patterns (uses https://urlpattern.spec.whatwg.org/). Silently detaches from targets with blocked URLs upon connection, and blocks runtime requests (including navigations and subresources). Accepts an array of patterns. A pattern that uses a regexp group or a named group (`:name`) in any component (for example `(127\.\d+\.\d+\.\d+)` in the hostname or `*://127.0.0.1::port/*`) is rejected, because it is not enforced on redirects or subresources; use an exact value or a `*` wildcard instead.
  - **Type:** array

- **`--allowedUrlPattern`/ `--allowed-url-pattern`**
  Restricts browser's network access by allowing only specified URL patterns (uses https://urlpattern.spec.whatwg.org/). Requires Chrome 149+. Silently detaches from targets with unallowed URLs upon connection, and blocks runtime requests (including navigations and subresources). Accepts an array of patterns. A pattern that uses a regexp group or a named group (`:name`) in any component (for example `(127\.\d+\.\d+\.\d+)` in the hostname or `*://127.0.0.1::port/*`) is rejected, because it is not enforced on redirects or subresources; use an exact value or a `*` wildcard instead.
  - **Type:** array

- **`--screenshotFormat`/ `--screenshot-format`**
  Override the default output format used by take_screenshot when the caller does not specify one. JPEG and WebP are ~3-5x smaller than PNG, which reduces transfer and storage size. To reduce context size use --screenshotMaxWidth / --screenshotMaxHeight, since image tokens scale with dimensions rather than encoded bytes. Unset preserves the existing default ("png").
  - **Type:** string
  - **Choices:** `jpeg`, `png`, `webp`
  - **Default:** `png`

- **`--screenshotQuality`/ `--screenshot-quality`**
  Override the default compression quality (0-100) used by take_screenshot for JPEG and WebP when the caller does not specify one. Lower values mean smaller files. Ignored for PNG. Unset preserves the Puppeteer default.
  - **Type:** number

- **`--screenshotMaxWidth`/ `--screenshot-max-width`**
  Maximum width in pixels for screenshots. If the captured image is wider, it is downscaled (preserving aspect ratio) before being returned. Reduces context size in AI conversations. Unset means no resize.
  - **Type:** number

- **`--screenshotMaxHeight`/ `--screenshot-max-height`**
  Maximum height in pixels for screenshots. If the captured image is taller, it is downscaled (preserving aspect ratio) before being returned. Can be combined with --screenshot-max-width; the smaller scale factor wins. Unset means no resize.
  - **Type:** number

- **`--logFile`/ `--log-file`**
  Path to a file to write debug logs to. Set the env variable `NODE_DEBUG` to `*` to enable verbose logs. Useful for submitting bug reports.
  - **Type:** string

- **`--pageIdRouting`/ `--page-id-routing`**
  Require pageId on page-scoped tools and route requests by page ID (useful for concurrent agent sessions). Use --no-page-id-routing to disable.
  - **Type:** boolean
  - **Default:** `true`

- **`--experimentalDevtools`/ `--experimental-devtools`**
  Whether to enable automation over DevTools targets
  - **Type:** boolean
  - **Default:** `false`

- **`--experimentalVision`/ `--experimental-vision`**
  Whether to enable coordinate-based tools such as click_at(x,y). Usually requires a computer-use model able to produce accurate coordinates by looking at screenshots.
  - **Type:** boolean
  - **Default:** `false`

- **`--memoryDebugging`/ `--memory-debugging`, `--experimentalMemory`**
  Whether to enable memory debugging tools.
  - **Type:** boolean
  - **Default:** `false`

- **`--experimentalStructuredContent`/ `--experimental-structured-content`**
  Whether to output structured formatted content.
  - **Type:** boolean
  - **Default:** `false`

- **`--experimentalIncludeAllPages`/ `--experimental-include-all-pages`**
  Whether to include all kinds of pages such as webviews or background pages as pages.
  - **Type:** boolean
  - **Default:** `false`

- **`--experimentalScreencast`/ `--experimental-screencast`**
  Exposes experimental screencast tools (requires ffmpeg). Install ffmpeg https://www.ffmpeg.org/download.html and ensure it is available in the MCP server PATH.
  - **Type:** boolean
  - **Default:** `false`

- **`--experimentalFfmpegPath`/ `--experimental-ffmpeg-path`**
  Path to ffmpeg executable for screencast recording.
  - **Type:** string

- **`--experimentalScreencastFps`/ `--experimental-screencast-fps`**
  Frames per second to use for screencast recording. Lower values can reduce memory pressure on pages that produce frames faster than ffmpeg can encode them.
  - **Type:** number

- **`--performanceCrux`/ `--performance-crux`**
  Set to false to disable sending URLs from performance traces to CrUX API to get field performance data.
  - **Type:** boolean
  - **Default:** `true`

- **`--usageStatistics`/ `--usage-statistics`**
  Set to false to opt-out of usage statistics collection. Google collects usage data to improve the tool, handled under the Google Privacy Policy (https://policies.google.com/privacy). This is independent from Chrome browser metrics. Disabled if `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` or `CI` env variables are set.
  - **Type:** boolean
  - **Default:** `true`

- **`--javascriptEvaluation`/ `--javascript-evaluation`**
  Set to false to disable JavaScript execution. When disabled, evaluation tools (evaluate_script and slim evaluate) are disabled, the initScript parameter in navigate_page is turned off, and navigating to javascript:, data:, or vbscript: URLs is disallowed.
  - **Type:** boolean
  - **Default:** `true`

- **`--fileNavigations`/ `--file-navigations`**
  Set to false to disallow navigating to file: URLs. When disabled, new_page, navigate_page and the slim navigate tool reject file: URLs, including view-source: URLs that target them. This restricts navigations the server performs. It is not a filesystem sandbox: it does not affect pages the browser already had open when the server connected, and the browser can reach the filesystem by other means. Use OS sandboxing for full filesystem confinement.
  - **Type:** boolean
  - **Default:** `true`

- **`--sourceMaps`/ `--source-maps`**
  Whether to enable source maps in DevTools. Use --no-source-maps to disable.
  - **Type:** boolean
  - **Default:** `true`

- **`--slim`**
  Exposes a "slim" set of 3 tools covering navigation, script execution and screenshots only. Useful for basic browser tasks.
  - **Type:** boolean
  - **Default:** `false`

- **`--redactNetworkHeaders`/ `--redact-network-headers`**
  If true, redacts some of the network headers considered sensitive before returning to the client.
  - **Type:** boolean
  - **Default:** `false`

- **`--allowUnrestrictedPaths`/ `--allow-unrestricted-paths`**
  If set, disables the default path restriction that applies when the MCP client does not negotiate the roots capability. By default, file-writing tools are restricted to the OS temp directory when no roots are configured. Use this only when connecting a trusted local client that does not implement MCP roots and requires access to paths outside the temp directory.
  - **Type:** boolean
  - **Default:** `false`

- **`--filesystemRoot`/ `--filesystem-root`, `--workspace`**
  A directory that filesystem tools are allowed to access. May be specified more than once.
  - **Type:** array
  - **Default:** `OS temp directory`

- **`--config`**
  Path to JSON configuration file.
  - **Type:** string

<!-- END AUTO GENERATED OPTIONS -->

## Passing options

As flags, to the MCP server in the client config or to `chrome-devtools start`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "chrome-devtools-mcp",
      "args": [
        "--proxyServer=http://127.0.0.1:8080",
        "--proxyDomains=target.tld",
        "--acceptInsecureCerts"
      ]
    }
  }
}
```

Launch flags (`--displayMode`, `--gpu`, `--proxyServer`, `--proxyDomains`, `--chromeArg`, …) only take effect for the client that launches the shared Chrome; see [Changing flags / restarting](../README.md#changing-flags--restarting).

## Configuration file

Instead of flags, options can go in a JSON file, with camelCase keys:

```json
{
  "proxyServer": "http://127.0.0.1:8080",
  "proxyDomains": ["target.tld"],
  "browserIdleTimeoutMinutes": 120
}
```

The server uses the first file it finds, highest priority first (files are not merged):

1. the path passed with `--config`
2. `cd4a.config.json` in the current working directory
3. `cd4a.config.json` in `$PLUGIN_DATA`, when running as an agent plugin
4. `$XDG_CONFIG_HOME/cd4a/config.json`, falling back to `~/.config/cd4a/config.json`

Command-line flags override the file. `CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY` turns the search off (a `--config` file is still read).
