# Fast WebFetch MCP Server for Claude Code

A high-performance MCP server for web fetching in Claude Code using Firecrawl backend with automatic fallback.

## Features

| Tool                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `fast_fetch`          | Fetch URL, extract content, return markdown |
| `fast_fetch_raw`      | Return raw HTML without processing          |
| `fast_fetch_json`     | Fetch and parse JSON endpoints              |
| `fast_fetch_multiple` | Fetch multiple URLs in parallel             |

### How It Works

1. **Primary:** Uses Firecrawl API for JS rendering and comment extraction
2. **Fallback:** If Firecrawl unavailable, uses direct fetch + Mozilla Readability
3. **AI Summary:** Optional summarization via local LLM API

```
URL -> Try Firecrawl -> Success? -> AI Summary (optional) -> Result
              |
              v (failed/unavailable)
       Direct Fetch + Readability -> AI Summary (optional) -> Result
```

### fast_fetch Parameters

| Parameter       | Type    | Default  | Description                            |
| --------------- | ------- | -------- | -------------------------------------- |
| `url`           | string  | required | The URL to fetch                       |
| `prompt`        | string  | -        | AI summarization prompt                |
| `max_length`    | number  | 100000   | Maximum content length (chars)         |
| `include_links` | boolean | true     | Include hyperlinks in output           |
| `no_summarize`  | boolean | false    | Skip AI summarization even with prompt |

## Quick Install

### Using Claude CLI (Recommended)

```bash
# Clone the repo
git clone https://github.com/nikketryhard/fast-webfetch-mcp.git ~/fast-webfetch-mcp

# Install dependencies
cd ~/fast-webfetch-mcp && bun install

# Add MCP server with environment variables
claude mcp add fast-webfetch \
  -e FIRECRAWL_API_URL=http://localhost:3002 \
  -e FAST_WEBFETCH_API_URL=http://127.0.0.1:8045/v1 \
  -e FAST_WEBFETCH_MODEL=gemini-3-flash \
  -- bun run ~/fast-webfetch-mcp/src/index.ts

# Or minimal (uses defaults)
claude mcp add fast-webfetch -- bun run ~/fast-webfetch-mcp/src/index.ts
```

### Manual Installation

```bash
# Clone the repo
git clone https://github.com/nikketryhard/fast-webfetch-mcp.git ~/fast-webfetch-mcp

# Install dependencies
cd ~/fast-webfetch-mcp && bun install
```

Then add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "fast-webfetch": {
      "command": "bun",
      "args": ["run", "/home/YOUR_USERNAME/fast-webfetch-mcp/src/index.ts"],
      "env": {
        "FIRECRAWL_API_URL": "http://localhost:3002",
        "FAST_WEBFETCH_API_URL": "http://127.0.0.1:8045/v1",
        "FAST_WEBFETCH_MODEL": "gemini-3-flash"
      }
    }
  }
}
```

## Environment Variables

| Variable                | Default                    | Description                         |
| ----------------------- | -------------------------- | ----------------------------------- |
| `FIRECRAWL_API_URL`     | `http://localhost:3002`    | Firecrawl API endpoint              |
| `FAST_WEBFETCH_API_URL` | `http://127.0.0.1:8045/v1` | OpenAI-compatible API for summaries |
| `FAST_WEBFETCH_MODEL`   | `gemini-3-flash`           | Model name for summarization        |

## Firecrawl Setup (Optional but Recommended)

For best results (JS rendering, comments extraction), run Firecrawl locally:

```bash
# Using Docker
docker run -p 3002:3002 mendableai/firecrawl

# Or use the official Firecrawl MCP
claude mcp add firecrawl-mcp -e FIRECRAWL_API_URL=http://localhost:3002 -- npx -y firecrawl-mcp
```

Without Firecrawl, the server falls back to direct fetch + Readability (no JS rendering).

## Comparison with Native WebFetch

| Feature        | Native WebFetch       | Fast WebFetch        |
| -------------- | --------------------- | -------------------- |
| Reddit/Twitter | Blocked (403)         | Works                |
| User agent     | Claude-User (blocked) | Real browser UA      |
| JS rendering   | No                    | Yes (with Firecrawl) |
| Comments       | No                    | Yes (with Firecrawl) |
| Content        | Haiku-summarized      | Full markdown        |
| AI summary     | Haiku 3.5             | Configurable model   |
| Max length     | 100KB                 | Configurable         |
| Raw HTML       | No                    | Yes                  |
| JSON fetch     | No                    | Yes                  |
| Parallel fetch | No                    | Yes                  |
| Fallback       | None                  | Direct fetch         |

## Requirements

- [Bun](https://bun.sh/) runtime
- Claude Code 2.0+
- (Optional) Firecrawl for JS rendering
- (Optional) OpenAI-compatible API for summarization

## License

MIT

## Contributing

PRs welcome! Please open an issue first to discuss changes.
