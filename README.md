# fast-webfetch-mcp

A web-fetching MCP server that renders pages with a real browser running on
your own machine, then hands the model clean Markdown instead of a token
bill for 2MB of JavaScript.

Fetching costs nothing here: no API keys, no per-page pricing. And when a
site claims to block you, it is often just a headless-detection script that
a real Chromium walks straight through.

## How it works

Two small programs, one job:

```
MCP client (agent)
   │  JSON-RPC over stdio
   ▼
src/index.ts          Bun + MCP SDK — tool schemas, budgets, rendering
   │  spawns per request
   ▼
crawl4ai_worker.py    Python + Crawl4AI — headless Chromium, markdown extraction
   │
   ▼
The actual internet
```

The TypeScript server owns policy: timeouts, concurrency permits, output
truncation, optional Gemini-powered summarization. The Python worker owns
mechanics: browser lifecycle, rendering, retries. Neither knows the other's
job, and the contract between them is one JSON document on stdout.

## Install

Requirements: [Bun](https://bun.sh), Python 3.12+, and a GPU-agnostic amount
of patience for the first browser download.

```sh
git clone <this repo> ~/.local/share/mcp/fast-webfetch-mcp   # or anywhere
cd ~/.local/share/mcp/fast-webfetch-mcp
bun install
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python crawl4ai
```

Verify the browser side works:

```sh
FAST_WEBFETCH_SMOKE_URL=https://example.com bun run src/index.ts
```

You should see Markdown for the example domain. If instead you see a stack
trace about Playwright browsers, run `crawl4ai-setup` from the venv and try
again — it installs the right Chromium build for you.

## Wire it into your agent

```json
{
  "mcpServers": {
    "fast-webfetch": {
      "type": "stdio",
      "command": "/usr/bin/mullvad-exclude",
      "args": ["/home/you/.bun/bin/bun", "run", "/path/to/fast-webfetch-mcp/src/index.ts"],
      "env": { "PATH": "/home/you/.bun/bin:/usr/bin:/bin" }
    }
  }
}
```

The `mullvad-exclude` wrapper is optional; it just lets fetch traffic bypass a
VPN so sites see your real IP. Plain `"command": "bun"` works identically.

## Tools

### `fast_fetch` — one URL to Markdown

| Argument | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | |
| `prompt` | string | — | If set, a grounded answer instead of the full page |
| `max_length` | number | 40,000 | Middle-truncation keeps head and tail |
| `full_content` | boolean | false | Raise cap to 100,000 chars |
| `timeout_ms` | number | 25,000 | Hard ceiling, browser render included |

### `fast_fetch_raw` — one URL to raw HTML

Same arguments minus `prompt`. Use it when Markdown loses the thing you need:
tables, `data-` attributes, meta tags, exact markup.

### `fast_fetch_multiple` — up to 15 URLs in one batch

| Argument | Type | Default | Notes |
|---|---|---|---|
| `urls` | string[] | required | 1–15 absolute http(s) URLs |
| `max_length` | number | 40,000 | Per URL |
| `full_content` | boolean | false | Per URL |
| `timeout_ms` | number | 25,000 | Whole batch, shared |

Each URL comes back as its own section with a metadata header (`url`,
`status`, `elapsed_ms`, `truncated`). One slow site cannot starve the others —
it just gets a per-item timeout error while its batch-mates succeed.

## Configuration

All optional, all environment variables.

### Server knobs

| Variable | Default | Purpose |
|---|---|---|
| `FAST_WEBFETCH_MAX_LENGTH` | `40000` | Default per-page character cap |
| `FAST_WEBFETCH_HARD_MAX_LENGTH` | `100000` | Ceiling for `full_content` |
| `FAST_WEBFETCH_TIMEOUT_MS` | `25000` | Default fetch timeout |
| `FAST_WEBFETCH_MULTIPLE_CONCURRENCY` | `12` | Parallel browser slots (max 32) |
| `FAST_WEBFETCH_DISABLE_SUMMARY` | unset | `1` removes `prompt` support entirely |
| `FAST_WEBFETCH_PYTHON` | `<repo>/.venv/bin/python` | Worker interpreter |
| `FAST_WEBFETCH_WORKER` | `<repo>/crawl4ai_worker.py` | Worker path |
| `GEMINI_API_KEY` / `GEMINI_API_KEY_FILE` | — | Only needed for `prompt` summarization |

### Browser knobs

| Variable | Default | Purpose |
|---|---|---|
| `CRAWL4AI_STEALTH` | off | `1` enables anti-detection browser tweaks |
| `CRAWL4AI_BROWSER` | chromium | `browser_type` passed to Crawl4AI |
| `CRAWL4AI_HEADFUL` | off | `1` shows the browser. Yes, on your screen |
| `CRAWL4AI_PROXY_URL` | off | Proxy for egress |
| `CRAWL4AI_WAIT_UNTIL` | `domcontentloaded` | Playwright wait strategy |
| `CRAWL4AI_SCAN_FULL_PAGE` | off | `1` scrolls the page before extraction |
| `CRAWL4AI_DELAY_SECONDS` | `0` | Settle time before HTML capture |

## Behavior worth knowing

JS-heavy sites often return an empty shell under the default wait strategy.
When a 200 comes back with no content, the worker retries once with
`networkidle`, inside the same timeout budget — worst case you wait once, not
twice. Connection failures and HTTP errors, meanwhile, stay single-attempt:
retrying a dead host is just a slower way to fail.

`fast_fetch` and `fast_fetch_multiple` draw from the same pool of 12 browser
slots, so a big batch cannot starve a concurrent single fetch. Demand beyond
the pool queues; a batch asking for more slots than exist gets what is free.

Finally, `max_length` exists because your agent's context window is a budget,
not a landfill.

## When things break, you get a log path

Failures are sorted into two piles: the internet being flaky (timeouts, slow
sites, per-item batch deadline errors) and the tool actually breaking
(worker won't spawn, worker crashed, stdout overflow, unparseable output).
Only the second pile writes a log — the first just gets an honest error tag.

A tool-side failure ends with:

```
log: /path/to/fast-webfetch-mcp/logs/2026-08-22T09-02-06-780Z-fast_fetch.json
```

Inside: the tool, exact arguments, worker input, and the full failure record
(stage, exit code, signal, stderr tail) — enough to replay the request
verbatim:

```sh
FAST_WEBFETCH_INPUT='{"url":"https://example.com","max_length":40000}' \
  .venv/bin/python crawl4ai_worker.py
```

Redirect with `FAST_WEBFETCH_LOGS_DIR`.

## Staying under 30 seconds

Agent harnesses tend to kill MCP calls around the 30-second mark, so this
server treats 28s as the hard wall. Every tool answers before it: finished
results if the fetch made it, otherwise structured per-item errors saying
which stage ate the time. A batch that runs out of budget still returns the
items that finished.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Crawl4AI worker missing` | Repo moved; check `FAST_WEBFETCH_WORKER` points at `crawl4ai_worker.py` |
| `Crawl4AI python missing` | `.venv` missing or wrong interpreter; set `FAST_WEBFETCH_PYTHON` |
| Everything times out on one site | Site is genuinely slow or hostile; try `CRAWL4AI_STEALTH=1` |
| `Batch deadline exceeded` on some items | Expected: shared 25s budget, stragglers get per-item errors |
| Empty markdown on SPAs | Should self-heal via retry; if not, raise `CRAWL4AI_DELAY_SECONDS` |

## Development

```sh
bun install
bun test            # 18 tests, no network needed
bun run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
```

The Python worker can be driven directly, which is the fastest way to debug
fetch behavior without the MCP layer:

```sh
FAST_WEBFETCH_INPUT='{"url":"https://example.com","max_length":500}' \
  .venv/bin/python crawl4ai_worker.py
```

## See also

- [ddg-search](../ddg-search) — the natural front end: searches, then hands
  result URLs to this server
- [Crawl4AI](https://docs.crawl4ai.com/) — the crawling engine underneath
- [Model Context Protocol](https://modelcontextprotocol.io) — the wire protocol

## License

MIT.
