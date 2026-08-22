#!/usr/bin/env python3
import asyncio
import contextlib
import json
import os
import sys
from typing import Any

DEFAULT_MAX_LENGTH = 40_000
HARD_MAX_LENGTH = 100_000
DEFAULT_TIMEOUT_MS = 25_000
DEFAULT_CONCURRENCY = 3
MAX_CONCURRENCY = 32


def positive_int(value: Any, fallback: int, maximum: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    if parsed <= 0:
        return fallback
    return min(parsed, maximum) if maximum else parsed


def middle_truncate(text: str, max_length: int) -> tuple[str, bool, int]:
    original_chars = len(text)
    if original_chars <= max_length:
        return text, False, original_chars
    marker = f"\n\n... [truncated {max(original_chars - max_length, 0)} characters] ...\n\n"
    if max_length <= len(marker):
        return marker[:max_length], True, original_chars
    half = max((max_length - len(marker)) // 2, 0)
    tail = max_length - len(marker) - half
    return f"{text[:half]}{marker}{text[-tail:] if tail else ''}", True, original_chars


def markdown_text(markdown: Any) -> str:
    if isinstance(markdown, str):
        return markdown
    for attr in ("fit_markdown", "raw_markdown", "markdown"):
        value = getattr(markdown, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    return str(markdown or "")


def error_result(
    url: str,
    error: str,
    timeout_ms: int,
    *,
    stage: str,
    error_type: str,
    elapsed_ms: int = 0,
    status_code: int | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "error",
        "url": url,
        "backend": "crawl4ai",
        "stage": stage,
        "error_type": error_type,
        "error": error,
        "timeout_ms": timeout_ms,
        "elapsed_ms": elapsed_ms,
    }
    if status_code is not None:
        result["status_code"] = status_code
    return result


def elapsed_ms(started: float) -> int:
    return round((asyncio.get_running_loop().time() - started) * 1000)


def crawl_configs(timeout_ms: int) -> tuple[Any, Any]:
    from crawl4ai import BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.async_configs import ProxyConfig

    proxy_url = os.getenv("CRAWL4AI_PROXY_URL", "").strip()
    proxy_config = ProxyConfig(server=proxy_url) if proxy_url else None
    browser_kwargs: dict[str, Any] = {}
    if os.getenv("CRAWL4AI_HEADFUL") == "1":
        browser_kwargs["headless"] = False
    if os.getenv("CRAWL4AI_BROWSER"):
        browser_kwargs["browser_type"] = os.getenv("CRAWL4AI_BROWSER")
    if proxy_config:
        browser_kwargs["proxy_config"] = proxy_config
    if os.getenv("CRAWL4AI_USER_AGENT"):
        browser_kwargs["user_agent"] = os.getenv("CRAWL4AI_USER_AGENT")
    if os.getenv("CRAWL4AI_STEALTH"):
        browser_kwargs["enable_stealth"] = os.getenv("CRAWL4AI_STEALTH") == "1"

    run_kwargs: dict[str, Any] = {"cache_mode": CacheMode.BYPASS, "page_timeout": timeout_ms}
    if os.getenv("CRAWL4AI_SCAN_FULL_PAGE"):
        run_kwargs["scan_full_page"] = os.getenv("CRAWL4AI_SCAN_FULL_PAGE") == "1"
    if os.getenv("CRAWL4AI_WAIT_UNTIL"):
        run_kwargs["wait_until"] = os.getenv("CRAWL4AI_WAIT_UNTIL")
    if os.getenv("CRAWL4AI_DELAY_SECONDS"):
        run_kwargs["delay_before_return_html"] = float(os.getenv("CRAWL4AI_DELAY_SECONDS", "0"))
    return BrowserConfig(**browser_kwargs), CrawlerRunConfig(**run_kwargs)


def serialize_result(
    result: Any, requested_url: str, max_length: int, timeout_ms: int, started: float,
    *, raw_html: bool = False, no_truncate: bool = False,
) -> dict[str, Any]:
    success = bool(getattr(result, "success", False))
    error_message = getattr(result, "error_message", None)
    raw_status_code = getattr(result, "status_code", None)
    status_code = int(raw_status_code) if raw_status_code is not None else None
    final_url = getattr(result, "url", None) or requested_url
    title = getattr(result, "title", None) or "Fetched Content"
    if not success:
        return error_result(
            final_url, error_message or (f"Crawl failed with status {status_code}" if status_code is not None else "Crawl failed without an HTTP status"), timeout_ms,
            stage="crawl", error_type="CrawlError", elapsed_ms=elapsed_ms(started), status_code=status_code,
        )

    if raw_html:
        content = getattr(result, "html", "") or getattr(result, "cleaned_html", "") or ""
        key = "raw_html"
    else:
        content = markdown_text(getattr(result, "markdown", ""))
        key = "markdown"

    if no_truncate:
        truncated = False
        original_chars = len(content)
    else:
        content, truncated, original_chars = middle_truncate(content, max_length)
    if not content.strip():
        return error_result(
            final_url, "Crawl4AI returned empty content", timeout_ms,
            stage="content", error_type="EmptyContentError", elapsed_ms=elapsed_ms(started), status_code=status_code,
        )

    return {
        "status": "ok", "url": final_url, "status_code": status_code or 200, "title": title, key: content,
        "truncated": truncated, "chars_returned": len(content), "original_chars": original_chars,
        "bytes_read": len(content.encode("utf-8")), "timeout_ms": timeout_ms,
        "elapsed_ms": elapsed_ms(started), "backend": "crawl4ai",
    }


def should_retry_empty(serialized: dict[str, Any]) -> bool:
    if serialized.get("status") != "error":
        return False
    if serialized.get("error_type") == "EmptyContentError":
        return True
    # crawl4ai 0.9.x reports near-empty HTTP 200 bodies as CrawlError
    # ("Blocked by anti-bot protection") — JS shells that typically recover
    # once rendering settles. Connectivity failures carry no status_code,
    # so they stay single-attempt.
    return serialized.get("error_type") == "CrawlError" and serialized.get("status_code") == 200


async def crawl_with_retry(
    crawler: Any, url: str, run_config: Any, max_length: int, timeout_ms: int, started: float,
    *, raw_html: bool = False, no_truncate: bool = False,
) -> dict[str, Any]:
    first = await crawler.arun(url=url, config=run_config)
    serialized = serialize_result(first, url, max_length, timeout_ms, started, raw_html=raw_html, no_truncate=no_truncate)
    if not should_retry_empty(serialized):
        return serialized
    # JS-rendered sites often yield an empty shell under the default
    # domcontentloaded wait; one bounded retry with networkidle recovers them.
    # Skipped once the shared batch budget is more than half spent.
    if elapsed_ms(started) > timeout_ms * 0.55:
        return serialized
    retry_config = run_config.clone()
    retry_config.wait_until = "networkidle"
    retry_config.delay_before_return_html = 1.0
    result = await crawler.arun(url=url, config=retry_config)
    return serialize_result(result, url, max_length, timeout_ms, started, raw_html=raw_html, no_truncate=no_truncate)


async def crawl_one(url: str, max_length: int, timeout_ms: int, raw_html: bool = False, no_truncate: bool = False) -> dict[str, Any]:
    started = asyncio.get_running_loop().time()
    try:
        from crawl4ai import AsyncWebCrawler
        browser_config, run_config = crawl_configs(timeout_ms)
        with contextlib.redirect_stdout(sys.stderr):
            async with asyncio.timeout(timeout_ms / 1000):
                async with AsyncWebCrawler(config=browser_config) as crawler:
                    return await crawl_with_retry(
                        crawler, url, run_config, max_length, timeout_ms, started,
                        raw_html=raw_html, no_truncate=no_truncate,
                    )
    except TimeoutError:
        return error_result(
            url, f"Crawl4AI timed out after {timeout_ms}ms", timeout_ms,
            stage="crawl", error_type="TimeoutError", elapsed_ms=elapsed_ms(started),
        )
    except Exception as error:
        return error_result(
            url, str(error), timeout_ms, stage="crawl",
            error_type=type(error).__name__, elapsed_ms=elapsed_ms(started),
        )


async def crawl_many(
    urls: list[str], max_length: int, timeout_ms: int, concurrency: int,
    raw_html: bool = False, no_truncate: bool = False,
) -> list[dict[str, Any]]:
    started = asyncio.get_running_loop().time()
    results: list[dict[str, Any] | None] = [None] * len(urls)
    stages = ["queue"] * len(urls)
    semaphore = asyncio.Semaphore(concurrency)

    tasks: list[asyncio.Task[None]] = []
    try:
        from crawl4ai import AsyncWebCrawler
        browser_config, run_config = crawl_configs(timeout_ms)
        with contextlib.redirect_stdout(sys.stderr):
            async with asyncio.timeout(timeout_ms / 1000):
                async with AsyncWebCrawler(config=browser_config) as crawler:
                    async def run(index: int, url: str) -> None:
                        async with semaphore:
                            stages[index] = "crawl"
                            try:
                                serialized = await crawl_with_retry(
                                    crawler, url, run_config.clone(), max_length, timeout_ms, started,
                                    raw_html=raw_html, no_truncate=no_truncate,
                                )
                                results[index] = {"input_url": url, **serialized}
                            except asyncio.CancelledError:
                                raise
                            except Exception as error:
                                results[index] = {"input_url": url, **error_result(
                                    url, str(error), timeout_ms, stage="crawl",
                                    error_type=type(error).__name__, elapsed_ms=elapsed_ms(started),
                                )}

                    tasks = [asyncio.create_task(run(index, url)) for index, url in enumerate(urls)]
                    await asyncio.gather(*tasks)
    except TimeoutError:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as error:
        batch_elapsed = elapsed_ms(started)
        for index, url in enumerate(urls):
            if results[index] is None:
                results[index] = {"input_url": url, **error_result(
                    url, str(error), timeout_ms, stage=stages[index],
                    error_type=type(error).__name__, elapsed_ms=batch_elapsed,
                )}

    batch_elapsed = elapsed_ms(started)
    return [
        result if result is not None else {"input_url": url, **error_result(
            url, f"Batch deadline exceeded after {timeout_ms}ms", timeout_ms,
            stage=stages[index], error_type="TimeoutError", elapsed_ms=batch_elapsed,
        )}
        for index, (url, result) in enumerate(zip(urls, results))
    ]


async def main() -> int:
    try:
        payload = json.loads(os.environ.get("FAST_WEBFETCH_INPUT", "{}"))
    except json.JSONDecodeError as error:
        print(json.dumps(error_result(
            "", f"invalid FAST_WEBFETCH_INPUT JSON: {error}", DEFAULT_TIMEOUT_MS,
            stage="input", error_type=type(error).__name__,
        )))
        return 0

    max_length = positive_int(payload.get("max_length"), DEFAULT_MAX_LENGTH, HARD_MAX_LENGTH)
    timeout_ms = positive_int(payload.get("timeout_ms") or os.getenv("FAST_WEBFETCH_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
    concurrency = positive_int(payload.get("concurrency"), DEFAULT_CONCURRENCY, MAX_CONCURRENCY)
    raw_html = bool(payload.get("raw_html"))
    no_truncate = bool(payload.get("no_truncate"))
    urls = payload.get("urls") or ([payload["url"]] if payload.get("url") else [])
    if not urls:
        print(json.dumps(error_result(
            "", "FAST_WEBFETCH_INPUT requires url or urls", timeout_ms,
            stage="input", error_type="ValueError",
        )))
        return 0

    string_urls = [str(url) for url in urls]
    # Shape follows request mode, not URL count: callers that send "urls"
    # (batch tools) always get a JSON array back, even for one URL. The TS
    # server rejects non-array batch output ("non-array batch JSON"), so
    # keying the shape on count broke single-URL batches.
    if len(string_urls) == 1 and not payload.get("urls"):
        result = await crawl_one(string_urls[0], max_length, timeout_ms, raw_html=raw_html, no_truncate=no_truncate)
        print(json.dumps(result, ensure_ascii=False))
        return 0

    results = await crawl_many(
        string_urls, max_length, timeout_ms, concurrency,
        raw_html=raw_html, no_truncate=no_truncate,
    )
    print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
