# chrome-devtools CLI

`chrome-devtools` runs the MCP server as a background daemon and calls its tools from the terminal. I mostly use it to bring up the shared Chrome for jev-ultrafast and weblogin when no MCP client is running (see the [README](../README.md#how-i-run-it)).

## Start the shared Chrome

```sh
chrome-devtools start --no-isolated \
  --userDataDir="$HOME/.cache/chrome-devtools-mcp/chrome-profile" \
  --proxyServer=http://127.0.0.1:8080 --proxyDomains=target.tld
chrome-devtools list_pages   # Chrome launches on the first tool call
```

How the CLI differs from the MCP server's defaults:

- **`--isolated` is on by default**, which gives you a throwaway Puppeteer Chrome with a temporary profile and none of the shared-browser behaviour. `--no-isolated` plus the shared `--userDataDir` is what attaches to (or launches) the shared Chrome. Without `--userDataDir` the CLI uses its own `~/.cache/chrome-devtools-mcp-cli` profile.
- **Not headless:** unlike upstream's CLI, it uses `--displayMode` (default `virtual`) with the GPU, like the MCP server. `--headless` still works.
- **Unrestricted file access** by default; `--workspace=DIR` (repeatable) limits file tools to those directories.

`start` forwards its flags to the daemon's server. They only affect Chrome if this call is the one that launches it; an already-running shared Chrome keeps its flags (see [Changing flags / restarting](../README.md#changing-flags--restarting)).

## Daemon

```sh
chrome-devtools status   # is the daemon running?
chrome-devtools stop     # stop the daemon (Chrome keeps running and idles out after 60 min)
```

The first tool call starts the daemon automatically if it isn't running, and the same daemon serves later calls. After `npm run build`, run `chrome-devtools start …` again so the daemon runs the new code (a version-mismatch warning tells you when it's stale).

## Calling tools

```sh
chrome-devtools <tool> [positional args] [--flags]
```

Required arguments are positional; page-scoped tools take the page id first. Optional arguments are flags. Tools that need extra categories (e.g. `--categoryExtensions`) and a few others (`wait_for`, `fill_form`) aren't available in the CLI. See the [tool reference](./tool-reference.md) for every tool's arguments.

```sh
chrome-devtools new_page "https://example.com"
chrome-devtools navigate_page 1 --url "https://example.org"
chrome-devtools take_snapshot 1
chrome-devtools click 1 "element-uid-123"
chrome-devtools fill 1 "input-uid-456" "search query"
chrome-devtools evaluate_script "() => document.title" --pageId 1
chrome-devtools take_screenshot 1 --filePath shot.png
chrome-devtools list_pages --output-format=json   # raw JSON instead of the summary
```

## Logs

The daemon doesn't write to the terminal. To capture its logs:

```sh
chrome-devtools stop
NODE_DEBUG=* chrome-devtools start --logFile=/tmp/cdt.log --no-isolated --userDataDir=…
```

## Implementation

Commands are generated from the tool definitions by `scripts/generate-cli.ts` (`npm run cli:generate`); server flags that make no sense for the CLI are filtered in `src/bin/chrome-devtools.ts`, and the CLI's own defaults are in `getMcpOptionsForViaCli` (`src/config/mcp-options.ts`).
