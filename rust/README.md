# fast-webfetch-mcp-rs

Rust rewrite prototype focused on lower memory pressure for high-frequency invocation.

Flow matches the previous server behavior:

1. Firecrawl first (`http://localhost:3002/v1/scrape`)
2. Fallback to direct fetch when Firecrawl is unavailable/fails

## Why this version uses less memory

- Streams response body via `reqwest::Response::bytes_stream()` instead of `text()/json()` full-buffer helpers.
- Enforces a hard byte cap while streaming (`max_bytes`) and rejects oversize payloads early.
- Bounds client pool memory (`pool_max_idle_per_host`, short idle timeout).
- Limits final output size via middle-truncate (`max_length`).

## Run

```bash
cargo run
```

Input is passed as env var JSON:

```bash
FAST_WEBFETCH_INPUT='{"url":"https://example.com","max_length":100000,"max_bytes":4194304}' cargo run
```

Output is JSON with `url`, `status`, `title`, `markdown`, `truncated`, `bytes_read`, `backend`.
