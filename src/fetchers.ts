import { CONFIG, WORKER_REPORT_GRACE_MS } from "./config.js";
import { workerFailureText } from "./render.js";
import { parseWorkerJson, runWorker } from "./worker.js";
import type { BatchItem, ScrapeResult } from "./types.js";

function scrapeResult(
  parsed: Record<string, unknown>,
  url: string,
  key: "markdown" | "raw_html",
  stderrTail?: string,
): ScrapeResult {
  if (parsed.status === "error") {
    const details = [
      typeof parsed.stage === "string" ? `stage=${parsed.stage}` : undefined,
      typeof parsed.error_type === "string" ? `error_type=${parsed.error_type}` : undefined,
      typeof parsed.status_code === "number" ? `status=${parsed.status_code}` : undefined,
      typeof parsed.elapsed_ms === "number" ? `elapsed_ms=${parsed.elapsed_ms}` : undefined,
      typeof parsed.timeout_ms === "number" ? `timeout_ms=${parsed.timeout_ms}` : undefined,
      typeof parsed.backend === "string" ? `backend=${parsed.backend}` : undefined,
    ].filter(Boolean).join(" ");
    const message = typeof parsed.error === "string" ? parsed.error : "Crawl4AI worker returned error status";
    const diagnostics = stderrTail ? ` stderr_tail=${JSON.stringify(stderrTail)}` : "";
    return { success: false, error: `${details ? `${message} (${details})` : message}${diagnostics}` };
  }

  return {
    success: true,
    markdown: key === "markdown" && typeof parsed.markdown === "string" ? parsed.markdown : undefined,
    rawHtml: key === "raw_html" && typeof parsed.raw_html === "string" ? parsed.raw_html : undefined,
    metadata: {
      title: typeof parsed.title === "string" ? parsed.title : "",
      sourceURL: typeof parsed.url === "string" ? parsed.url : url,
      statusCode: typeof parsed.status_code === "number" ? parsed.status_code : 200,
      backend: typeof parsed.backend === "string" ? parsed.backend : "crawl4ai",
      truncated: parsed.truncated === true,
      charsReturned: typeof parsed.chars_returned === "number" ? parsed.chars_returned : undefined,
      originalChars: typeof parsed.original_chars === "number" ? parsed.original_chars : undefined,
      timeoutMs: typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : undefined,
    },
  };
}

export async function fetchMarkdown(
  url: string,
  maxLength: number,
  timeoutMs: number,
  noTruncate = false,
  outerTimeoutMs = timeoutMs + WORKER_REPORT_GRACE_MS,
): Promise<ScrapeResult> {
  const run = await runWorker({ url, max_length: maxLength, no_truncate: noTruncate }, timeoutMs, 1, outerTimeoutMs);
  if (!run.ok) return { success: false, error: workerFailureText(run.failure) };

  try {
    return scrapeResult(parseWorkerJson(run.stdout) as Record<string, unknown>, url, "markdown", run.stderrTail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Crawl4AI worker returned invalid JSON: ${message}` };
  }
}

export async function fetchRawHtml(url: string, maxLength: number, timeoutMs: number): Promise<ScrapeResult> {
  const run = await runWorker({ url, max_length: maxLength, raw_html: true }, timeoutMs);
  if (!run.ok) return { success: false, error: workerFailureText(run.failure) };

  try {
    return scrapeResult(parseWorkerJson(run.stdout) as Record<string, unknown>, url, "raw_html", run.stderrTail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Crawl4AI worker returned invalid JSON: ${message}` };
  }
}

export async function fetchMarkdownBatch(urls: string[], maxLength: number, timeoutMs: number): Promise<BatchItem[] | string> {
  const permitCount = Math.max(1, Math.min(CONFIG.multipleConcurrency, urls.length));
  const run = await runWorker({ urls, max_length: maxLength }, timeoutMs, permitCount);
  if (!run.ok) return workerFailureText(run.failure);

  try {
    const parsed = parseWorkerJson(run.stdout);
    if (!Array.isArray(parsed)) return "Crawl4AI worker returned non-array batch JSON";
    return (parsed as BatchItem[]).map((item) => item.status === "error" && run.stderrTail
      ? { ...item, error: `${item.error} stderr_tail=${JSON.stringify(run.stderrTail)}` }
      : item);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Crawl4AI worker returned invalid batch JSON: ${message}`;
  }
}
