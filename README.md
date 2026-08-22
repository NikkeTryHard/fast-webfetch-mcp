# Fast WebFetch MCP Server for Claude Code

A high-performance MCP server for web fetching in Claude Code using local Crawl4AI for browser rendering and Markdown extraction.

## Features

| Tool                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `fast_fetch`          | Fetch URL, extract content, return markdown |
| `fast_fetch_raw`      | Return raw HTML without processing          |
| `fast_fetch_multiple` | Fetch multiple URLs in parallel             |

### How It Works

1. **Primary:** Uses local Crawl4AI with Playwright Chromium and Markdown output
2. **AI Summary:** Optional Gemini summarization grounded in the fetched Markdown

```
URL -> Crawl4AI worker -> Markdown -> AI Summary (optional) -> Result
```

### fast_fetch Parameters

| Parameter       | Type    | Default  | Description                            |
| --------------- | ------- | -------- | -------------------------------------- |
| `url`           | string  | required | The URL to fetch                       |
| `prompt`        | string  | -        | AI summarization prompt                |
| `max_length`    | number  | 40000    | Maximum returned content length (chars; hard max 100000) |
| `full_content`  | boolean | false    | Raise returned content cap to 100000 chars |
| `timeout_ms`    | number  | 25000    | Crawl or whole-batch deadline; maximum 25000 ms |

## This workstation install

Canonical tree (do not use `~/.config/opencode/mcp/fast-webfetch-mcp`):

```text
~/.local/share/mcp/fast-webfetch-mcp/
```

OMP already launches:

```bash
/usr/bin/mullvad-exclude /home/cachybtw/.bun/bin/bun run \
  /home/cachybtw/.local/share/mcp/fast-webfetch-mcp/src/index.ts
```

OpenCode uses:

```bash
/home/cachybtw/.local/share/mcp/fast-webfetch-wrapper.sh
```

### Manual reinstall (if needed)

```bash
cd ~/.local/share/mcp/fast-webfetch-mcp
bun install
uv venv .venv
uv pip install crawl4ai
.venv/bin/python -m playwright install chromium
```

## Environment Variables

| Variable                         | Default                                             | Description                                  |
| -------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `FAST_WEBFETCH_PYTHON`           | local `.venv/bin/python`                            | Python with Crawl4AI installed               |
| `FAST_WEBFETCH_TIMEOUT_MS`       | `25000`                                             | Crawl or whole-batch deadline; capped at 25 seconds |
| `FAST_WEBFETCH_MULTIPLE_CONCURRENCY` | `3`                                             | Shared cap for concurrent browser pages across requests |
| `FAST_WEBFETCH_DISABLE_SUMMARY`  | `0`                                                 | Return Markdown directly even with `prompt`  |
| `CRAWL4AI_PROXY_URL`             | _(empty)_                                           | Optional HTTP/SOCKS proxy URL                |
| `CRAWL4AI_HEADFUL`               | `0`                                                 | Set `1` for visible browser                  |
| `GEMINI_API_KEY`                 | key file fallback                                   | Gemini key for optional summaries            |

## Crawl4AI Setup

Install Crawl4AI in the local virtualenv and install Chromium browser binaries:

```bash
uv venv .venv
uv pip install crawl4ai
.venv/bin/python -m playwright install chromium
.venv/bin/python -m patchright install chromium
```

The worker uses local Crawl4AI with `CacheMode.BYPASS` and one shared Chromium instance per parallel batch. Batch pages run concurrently up to `FAST_WEBFETCH_MULTIPLE_CONCURRENCY`. Set `CRAWL4AI_PROXY_URL` when a target needs better IP reputation.

## Comparison with Native WebFetch

| Feature        | Native WebFetch       | Fast WebFetch        |
| -------------- | --------------------- | -------------------- |
| Reddit/Twitter | Blocked (403)         | Works                |
| User agent     | Claude-User (blocked) | Real browser UA      |
| JS rendering   | No                    | Yes (Crawl4AI/Playwright) |
| Comments       | No                    | Page-dependent            |
| Content        | Haiku-summarized      | Full markdown        |
| AI summary     | Haiku 3.5             | Configurable model   |
| Max length     | 100KB                 | Configurable         |
| Raw HTML       | No                    | Yes                  |
| JSON fetch     | No                    | Yes                  |
| Parallel fetch | No                    | Yes                  |
| Fallback       | None                  | Crawl4AI error details    |

## Requirements

- [Bun](https://bun.sh/) runtime
- Claude Code 2.0+
- Crawl4AI installed in `.venv`
- (Optional) Gemini API key for summarization

## License

MIT

## Contributing

PRs welcome! Please open an issue first to discuss changes.
