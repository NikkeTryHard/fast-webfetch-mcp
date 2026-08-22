import { CONFIG, WORKER_REPORT_GRACE_MS } from "./config.js";
import { isSeriousFailure, writeErrorLog } from "./diagnostics.js";
import { workerFailureText } from "./render.js";
import { parseWorkerJson, runWorker } from "./worker.js";
import type { BatchItem, ScrapeResult, WorkerFailure } from "./types.js";

export function withLog(tool: string, error: string, failure: WorkerFailure | undefined, payload: Record<string, unknown>): string {
  if (!failure || !isSeriousFailure(failure.stage)) return error;
  const path = writeErrorLog(tool, { ...payload, failure });
  return path ? `${error}\nlog: ${path}` : error;
}

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

async function fetchScrape(
  workerInput: Record<string, unknown>,
  url: string,
  key: "markdown" | "raw_html",
  timeoutMs: number,
  outerTimeoutMs: number,
): Promise<ScrapeResult> {
  const run = await runWorker(workerInput, timeoutMs, 1, outerTimeoutMs);
  if (!run.ok) {
    return { success: false, error: withLog("fast_fetch", workerFailureText(run.failure), run.failure, { url, workerInput }) };
  }

  try {
    return scrapeResult(parseWorkerJson(run.stdout) as Record<string, unknown>, url, key, run.stderrTail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = `Crawl4AI worker returned invalid JSON: ${message}`;
    const path = writeErrorLog("fast_fetch", { url, workerInput, stdout_tail: run.stdout.slice(-2000), message });
    return { success: false, error: path ? `${detail}\nlog: ${path}` : detail };
  }
}

export function fetchMarkdown(
  url: string,
  maxLength: number,
  timeoutMs: number,
  noTruncate = false,
  outerTimeoutMs = timeoutMs + WORKER_REPORT_GRACE_MS,
  renderOptions?: Record<string, unknown>,
): Promise<ScrapeResult> {
  const workerInput: Record<string, unknown> = { url, max_length: maxLength, no_truncate: noTruncate };
  if (renderOptions) workerInput.options = renderOptions;
  return fetchScrape(workerInput, url, "markdown", timeoutMs, outerTimeoutMs);
}

export function fetchRawHtml(url: string, maxLength: number, timeoutMs: number, renderOptions?: Record<string, unknown>): Promise<ScrapeResult> {
  const workerInput: Record<string, unknown> = { url, max_length: maxLength, raw_html: true };
  if (renderOptions) workerInput.options = renderOptions;
  return fetchScrape(workerInput, url, "raw_html", timeoutMs, timeoutMs + WORKER_REPORT_GRACE_MS);
}

export async function fetchMarkdownBatch(urls: string[], maxLength: number, timeoutMs: number, renderOptions?: Record<string, unknown>): Promise<BatchItem[] | string> {
  const permitCount = Math.max(1, Math.min(CONFIG.multipleConcurrency, urls.length));
  const workerInput: Record<string, unknown> = { urls, max_length: maxLength };
  if (renderOptions) workerInput.options = renderOptions;
  const run = await runWorker(workerInput, timeoutMs, permitCount);
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
