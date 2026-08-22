#!/usr/bin/env bun
/**
 * Crawl4AI-backed MCP server. Markdown fetches go through the local Python worker.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MAX_LENGTH = 40_000; // about 10k tokens for typical English/Markdown
const HARD_MAX_LENGTH = 100_000;
const MAX_CRAWL_TIMEOUT_MS = 25_000;
const REQUEST_BUDGET_MS = 29_000;
const TRANSPORT_MARGIN_MS = 1_000;
const WORKER_REPORT_GRACE_MS = 2_500;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const TERMINATE_GRACE_MS = 500;

const CONFIG = {
  maxLength: readPositiveInt("FAST_WEBFETCH_MAX_LENGTH", DEFAULT_MAX_LENGTH, HARD_MAX_LENGTH),
  hardMaxLength: readPositiveInt("FAST_WEBFETCH_HARD_MAX_LENGTH", HARD_MAX_LENGTH),
  timeoutMs: readPositiveInt("FAST_WEBFETCH_TIMEOUT_MS", MAX_CRAWL_TIMEOUT_MS, MAX_CRAWL_TIMEOUT_MS),
  // Parallel browser slots for this process (single + multi share the same pool).
  // Default 12 so fast_fetch_multiple is useful for ~10–15 URL batches; hard max 32.
  multipleConcurrency: readPositiveInt("FAST_WEBFETCH_MULTIPLE_CONCURRENCY", 12, 32),
  // Always resolve under this package tree (~/.local/share/mcp/fast-webfetch-mcp). Never ~/.config/opencode/mcp/.
  pythonBin:
    process.env.FAST_WEBFETCH_PYTHON || join(PACKAGE_ROOT, ".venv", "bin", "python"),
  crawl4aiWorker:
    process.env.FAST_WEBFETCH_WORKER || join(PACKAGE_ROOT, "crawl4ai_worker.py"),
  geminiApiKeyFile:
    process.env.GEMINI_API_KEY_FILE || "/home/cachybtw/.config/opencode/keys/.gemini-api-key",
  geminiTimeoutMs: 15_000,
  disableSummary: process.env.FAST_WEBFETCH_DISABLE_SUMMARY === "1",
} as const;

type WorkerFailure = {
  stage: "queue" | "spawn" | "timeout" | "worker" | "output";
  message: string;
  elapsedMs: number;
  timeoutMs: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stderrTail?: string;
};

type WorkerRunResult = { ok: true; stdout: string; stderrTail?: string } | { ok: false; failure: WorkerFailure };

type PermitLease = {
  count: number;
  release: () => void;
};

type PermitWaiter = {
  desired: number;
  resolve: (lease: PermitLease | undefined) => void;
  timer: NodeJS.Timeout;
};

class WorkerPermitPool {
  private available: number;
  private readonly waiters: PermitWaiter[] = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  acquire(desired: number, timeoutMs: number): Promise<PermitLease | undefined> {
    const permits = Math.max(1, Math.min(desired, this.capacity));
    if (this.available > 0) return Promise.resolve(this.grant(Math.min(permits, this.available)));

    const { promise, resolve } = Promise.withResolvers<PermitLease | undefined>();
    const waiter: PermitWaiter = {
      desired: permits,
      resolve,
      timer: setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs),
    };
    this.waiters.push(waiter);
    return promise;
  }

  private grant(count: number): PermitLease {
    this.available -= count;
    let released = false;
    return {
      count,
      release: () => {
        if (released) return;
        released = true;
        this.available += count;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.available > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(this.grant(Math.min(waiter.desired, this.available)));
    }
  }
}

const workerPermits = new WorkerPermitPool(CONFIG.multipleConcurrency);

function workerFailureText(failure: WorkerFailure): string {
  const details = [
    `stage=${failure.stage}`,
    `elapsed_ms=${failure.elapsedMs}`,
    `timeout_ms=${failure.timeoutMs}`,
    failure.exitCode !== undefined ? `exit_code=${failure.exitCode}` : undefined,
    failure.signal ? `signal=${failure.signal}` : undefined,
  ].filter(Boolean).join(" ");
  const stderr = failure.stderrTail ? ` stderr_tail=${JSON.stringify(failure.stderrTail)}` : "";
  return `${failure.message} (${details})${stderr}`;
}

type ScrapeResult = {
  success: boolean;
  markdown?: string;
  rawHtml?: string;
  metadata?: {
    title?: string;
    sourceURL?: string;
    statusCode?: number;
    backend?: string;
    truncated?: boolean;
    charsReturned?: number;
    originalChars?: number;
    timeoutMs?: number;
  };
  error?: string;
};

type BatchItem =
  | {
      input_url: string;
      status: "ok";
      url: string;
      title: string;
      markdown: string;
      status_code?: number;
      backend?: string;
      truncated?: boolean;
      chars_returned?: number;
      original_chars?: number;
      elapsed_ms?: number;
      timeout_ms?: number;
    }
  | {
      input_url: string;
      status: "error";
      error: string;
      url?: string;
      status_code?: number;
      backend?: string;
      stage?: string;
      error_type?: string;
      timeout_ms?: number;
      elapsed_ms?: number;
    };

function readPositiveInt(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function readSecretFile(path: string): string {
  const expandedPath = path.startsWith("~/") ? `${process.env.HOME || ""}/${path.slice(2)}` : path;
  try {
    return readFileSync(expandedPath, "utf8").trim();
  } catch {
    return "";
  }
}

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function boolArg(value: unknown): boolean {
  return value === true;
}

function resolveMaxLength(args: Record<string, unknown>): number {
  const requested = positiveNumber(args.max_length);
  const target = boolArg(args.full_content) ? CONFIG.hardMaxLength : (requested ?? CONFIG.maxLength);
  return Math.max(1, Math.min(target, CONFIG.hardMaxLength));
}

function resolveTimeoutMs(args: Record<string, unknown>): number {
  const requested = positiveNumber(args.timeout_ms);
  return Math.max(1_000, Math.min(requested ?? CONFIG.timeoutMs, MAX_CRAWL_TIMEOUT_MS));
}

async function runGemini(prompt: string, timeoutMs: number): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || readSecretFile(CONFIG.geminiApiKeyFile);
  if (!apiKey) {
    throw new Error("Gemini API key missing");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048 },
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(bodyText || `Gemini request failed with HTTP ${response.status}`);
    }
    return bodyText;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Gemini timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeContent(content: string, userPrompt: string, timeoutMs: number): Promise<string> {
  const prompt = `Use only the fetched page content below. If the content does not contain the answer, say that clearly. Be concise and cite exact page facts instead of guessing.

Fetched page content:
---
${content}
---

User request:
${userPrompt}`;

  if (timeoutMs < 1_000) {
    return `[Summarization failed: stage=summary error_type=DeadlineExceeded remaining_ms=${timeoutMs}]\n\n${content.slice(0, 5000)}...`;
  }

  try {
    const bodyText = await runGemini(prompt, Math.min(timeoutMs, CONFIG.geminiTimeoutMs));
    const data = JSON.parse(bodyText);
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text)
      .filter(Boolean)
      .join("\n");

    return text || "Gemini returned no text content";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Summarization failed: stage=summary error_type=${error instanceof Error ? error.name : "Error"} timeout_ms=${timeoutMs} message=${message}]\n\n${content.slice(0, 5000)}...`;
  }
}

async function runWorker(input: Record<string, unknown>, crawlTimeoutMs: number, permitCount = 1, outerTimeoutMs = crawlTimeoutMs + WORKER_REPORT_GRACE_MS): Promise<WorkerRunResult> {
  const startedAt = Date.now();
  const processTimeoutMs = Math.min(outerTimeoutMs, REQUEST_BUDGET_MS - TRANSPORT_MARGIN_MS);
  const failure = (stage: WorkerFailure["stage"], message: string, extra: Partial<WorkerFailure> = {}): WorkerRunResult => ({
    ok: false,
    failure: { stage, message, elapsedMs: Date.now() - startedAt, timeoutMs: crawlTimeoutMs, ...extra },
  });

  if (!existsSync(CONFIG.crawl4aiWorker)) {
    return failure(
      "spawn",
      `Crawl4AI worker missing: ${CONFIG.crawl4aiWorker} (package_root=${PACKAGE_ROOT}; expected install at ~/.local/share/mcp/fast-webfetch-mcp — not ~/.config/opencode/mcp/)`,
    );
  }
  if (!existsSync(CONFIG.pythonBin)) {
    return failure(
      "spawn",
      `Crawl4AI python missing: ${CONFIG.pythonBin} (set FAST_WEBFETCH_PYTHON or recreate .venv under ${PACKAGE_ROOT})`,
    );
  }

  const lease = await workerPermits.acquire(permitCount, processTimeoutMs);
  if (!lease) return failure("queue", "Crawl4AI worker concurrency queue timed out");

  const processRemainingMs = processTimeoutMs - (Date.now() - startedAt);
  const workerTimeoutMs = Math.min(crawlTimeoutMs, processRemainingMs - WORKER_REPORT_GRACE_MS);
  if (workerTimeoutMs < 1_000) {
    lease.release();
    return failure("queue", "Crawl4AI worker deadline expired in concurrency queue");
  }

  const workerInput: Record<string, unknown> = { ...input, timeout_ms: workerTimeoutMs };
  const urls = workerInput.urls;
  if (Array.isArray(urls)) {
    workerInput.concurrency = Math.max(1, Math.min(lease.count, urls.length));
  }

  const child = spawn(CONFIG.pythonBin, [CONFIG.crawl4aiWorker], {
    detached: true,
    env: {
      ...process.env,
      FAST_WEBFETCH_INPUT: JSON.stringify(workerInput),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrTail = Buffer.alloc(0);
  let forcedFailure: { stage: WorkerFailure["stage"]; message: string } | undefined;
  let spawnError: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const terminateGroup = (): void => {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, TERMINATE_GRACE_MS);
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (forcedFailure) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += buffer.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      forcedFailure = { stage: "output", message: `Crawl4AI worker stdout exceeded ${MAX_STDOUT_BYTES} bytes` };
      terminateGroup();
      return;
    }
    stdoutChunks.push(buffer);
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length >= STDERR_TAIL_BYTES) {
      stderrTail = Buffer.from(buffer.subarray(buffer.length - STDERR_TAIL_BYTES));
      return;
    }
    const excess = Math.max(0, stderrTail.length + buffer.length - STDERR_TAIL_BYTES);
    stderrTail = Buffer.concat([stderrTail.subarray(excess), buffer], Math.min(STDERR_TAIL_BYTES, stderrTail.length + buffer.length));
  });

  child.on("error", (error) => {
    spawnError = error;
  });

  const timeoutId = setTimeout(() => {
    forcedFailure = { stage: "timeout", message: `Crawl4AI worker failed to report within ${processTimeoutMs}ms (crawl_timeout_ms=${workerTimeoutMs})` };
    terminateGroup();
  }, processRemainingMs);

  const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.on("close", (code, signal) => resolveClose({ code, signal }));
  const { code, signal } = await closePromise;
  clearTimeout(timeoutId);
  clearTimeout(killTimer);
  lease.release();

  const exitDetails: Partial<WorkerFailure> = {
    exitCode: code ?? undefined,
    signal: signal ?? undefined,
    stderrTail: stderrTail.toString("utf8").trim() || undefined,
  };
  if (forcedFailure) return failure(forcedFailure.stage, forcedFailure.message, exitDetails);
  if (spawnError) return failure("spawn", spawnError.message, exitDetails);
  if (code !== 0) return failure("worker", `Crawl4AI worker exited unsuccessfully`, exitDetails);
  return {
    ok: true,
    stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
    stderrTail: stderrTail.toString("utf8").trim() || undefined,
  };
}

function parseWorkerJson(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastJsonLine = [...lines].reverse().find((line) => line.startsWith("{") || line.startsWith("["));
  if (!lastJsonLine) {
    throw new Error("worker produced no JSON");
  }
  return JSON.parse(lastJsonLine);
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

async function fetchMarkdown(
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

async function fetchRawHtml(url: string, maxLength: number, timeoutMs: number): Promise<ScrapeResult> {
  const run = await runWorker({ url, max_length: maxLength, raw_html: true }, timeoutMs);
  if (!run.ok) return { success: false, error: workerFailureText(run.failure) };

  try {
    return scrapeResult(parseWorkerJson(run.stdout) as Record<string, unknown>, url, "raw_html", run.stderrTail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Crawl4AI worker returned invalid JSON: ${message}` };
  }
}

async function fetchMarkdownBatch(urls: string[], maxLength: number, timeoutMs: number): Promise<BatchItem[] | string> {
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

function metadataHeader(fields: Record<string, string | number | boolean | undefined>): string {
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${key}: ${String(value).replace(/\n/g, " ")}`);
  return `---\n${lines.join("\n")}\n---`;
}

function renderSingle(content: string, result: ScrapeResult, truncated = result.metadata?.truncated ?? false): string {
  const meta = result.metadata ?? {};
  return `${metadataHeader({
    status: meta.statusCode ?? 200,
    truncated,
  })}\n\n${content}`;
}

const server = new Server(
  { name: "fast-webfetch", version: "6.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fast_fetch",
      description: CONFIG.disableSummary
        ? "Open one known URL and return source-grounded Markdown from local Crawl4AI. Use after search when URL likely contains answer, or when user gives URL. Not web search. Returns fetched page content only; no AI summary. Use full_content when truncation would hide needed facts; timeout capped at 25s."
        : "Open one known URL and return source-grounded Markdown from local Crawl4AI, or answer a specific prompt using only fetched content. Use after search when URL likely contains answer, or when user gives URL. Not web search. With prompt, answer must stay grounded in fetched page and say when content lacks answer. Use full_content when truncation would hide needed facts; timeout capped at 25s.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "URL to fetch" },
				...(CONFIG.disableSummary ? {} : { prompt: { type: "string", description: "Optional extraction/question. If set, returns concise answer grounded only in fetched content; must not infer beyond page." } }),
				max_length: { type: "number", description: `Maximum returned Markdown chars. Default ${CONFIG.maxLength}; hard max ${CONFIG.hardMaxLength}. Raise when page truncation hides needed facts.` },
				full_content: { type: "boolean", description: `Use hard max ${CONFIG.hardMaxLength} chars instead of default cap. Use for long docs/specs/source pages.` },
				timeout_ms: { type: "number", description: `Fetch timeout ms. Default ${CONFIG.timeoutMs}; max ${MAX_CRAWL_TIMEOUT_MS}.` },
			},
        required: ["url"],
      },
    },
    {
      name: "fast_fetch_raw",
      description: "Open one known URL and return raw HTML from local Crawl4AI. Use only when Markdown loses needed evidence: structured markup, scripts/data attributes, meta tags, tables, or exact HTML snippets. Not web search. Prefer fast_fetch for normal reading. full_content raises cap; timeout capped at 25s.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          max_length: { type: "number", description: `Maximum returned HTML chars. Default ${CONFIG.maxLength}; hard max ${CONFIG.hardMaxLength}.` },
          full_content: { type: "boolean", description: `Use hard max ${CONFIG.hardMaxLength} chars instead of default cap. Use when required markup may be late in document.` },
          timeout_ms: { type: "number", description: `Fetch timeout ms. Default ${CONFIG.timeoutMs}; max ${MAX_CRAWL_TIMEOUT_MS}.` },
        },
        required: ["url"],
      },
    },
    {
      name: "fast_fetch_multiple",
      description:
        "Open multiple known URLs in one parallel Crawl4AI batch and return Markdown for comparison/triage. " +
        "Use after search when several candidate pages need grounding. Not web search. " +
        "Pass up to ~15 URLs; process runs up to FAST_WEBFETCH_MULTIPLE_CONCURRENCY pages at once (default 12). " +
        "max_length applies per URL. One overall batch timeout capped at 25s — huge batches may partial-timeout.",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 15,
            description: "1–15 absolute http(s) URLs. Parallelism capped by process concurrency (default 12).",
          },
          max_length: {
            type: "number",
            description: `Maximum returned Markdown chars per URL. Default ${CONFIG.maxLength}; hard max ${CONFIG.hardMaxLength}.`,
          },
          full_content: {
            type: "boolean",
            description: `Use hard max ${CONFIG.hardMaxLength} chars per URL instead of default cap. Use for long docs/specs/source pages.`,
          },
          timeout_ms: {
            type: "number",
            description: `Whole batch timeout ms. Default ${CONFIG.timeoutMs}; max ${MAX_CRAWL_TIMEOUT_MS}.`,
          },
        },
        required: ["urls"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = asArgs(request.params.arguments);

  try {
    const maxLength = resolveMaxLength(args);
    const timeoutMs = resolveTimeoutMs(args);

    if (name === "fast_fetch") {
      const requestStartedAt = Date.now();
      const requestDeadline = requestStartedAt + REQUEST_BUDGET_MS;
      const url = args.url as string;
      const prompt = !CONFIG.disableSummary && typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
      const crawlBudgetMs = timeoutMs;
      const workerBudgetMs = Math.min(requestDeadline - requestStartedAt - TRANSPORT_MARGIN_MS, crawlBudgetMs + WORKER_REPORT_GRACE_MS);
      const result = await fetchMarkdown(url, maxLength, crawlBudgetMs, prompt !== undefined, workerBudgetMs);

      if (!result.success) {
        return { content: [{ type: "text", text: `Error fetching ${url}: ${result.error}` }], isError: true };
      }

      const markdown = result.markdown || "";
      if (prompt) {
        const summaryBudgetMs = requestDeadline - Date.now() - TRANSPORT_MARGIN_MS;
        const summary = await summarizeContent(markdown, prompt, summaryBudgetMs);
        return { content: [{ type: "text", text: renderSingle(summary, result, false) }] };
      }

      return { content: [{ type: "text", text: renderSingle(markdown, result) }] };
    }

    if (name === "fast_fetch_raw") {
      const url = args.url as string;
      const result = await fetchRawHtml(url, maxLength, timeoutMs);
      if (!result.success) {
        return { content: [{ type: "text", text: `Error fetching ${url}: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text", text: renderSingle(result.rawHtml || "", result) }] };
    }

    if (name === "fast_fetch_multiple") {
      const urls = Array.isArray(args.urls) ? (args.urls as string[]) : [];
      const result = await fetchMarkdownBatch(urls, maxLength, timeoutMs);
      if (typeof result === "string") {
        return { content: [{ type: "text", text: `Error fetching multiple URLs: ${result}` }], isError: true };
      }

      const output = result.map((item) => {
        if (item.status === "error") {
          return `${metadataHeader({
            url: item.input_url,
            status: item.status_code,
            backend: item.backend,
            stage: item.stage,
            error_type: item.error_type,
            elapsed_ms: item.elapsed_ms,
            timeout_ms: item.timeout_ms,
            truncated: false,
          })}\n\nError: ${item.error}`;
        }
        return `${metadataHeader({
          url: item.input_url,
          status: item.status_code ?? 200,
          backend: item.backend,
          elapsed_ms: item.elapsed_ms,
          timeout_ms: item.timeout_ms,
          truncated: item.truncated ?? false,
        })}\n\n${item.markdown}`;
      }).join("\n\n---\n\n");
      return { content: [{ type: "text", text: output }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

async function runCliSmoke(): Promise<void> {
  const url = process.env.FAST_WEBFETCH_SMOKE_URL;
  if (!url) return;

  const smokeTimeoutMs = readPositiveInt("FAST_WEBFETCH_SMOKE_TIMEOUT_MS", CONFIG.timeoutMs, MAX_CRAWL_TIMEOUT_MS);
  const result = await fetchMarkdown(
    url,
    readPositiveInt("FAST_WEBFETCH_SMOKE_MAX_LENGTH", 1000, CONFIG.hardMaxLength),
    smokeTimeoutMs,
  );
  if (!result.success) {
    console.error(`Error fetching ${url}: ${result.error}`);
    process.exit(1);
  }

  if (CONFIG.disableSummary) {
    console.log(renderSingle(result.markdown || "", result));
    return;
  }

  const prompt = process.env.FAST_WEBFETCH_SMOKE_PROMPT || "Summarize the fetched page.";
  console.log(await summarizeContent(result.markdown || "", prompt, Math.min(CONFIG.geminiTimeoutMs, REQUEST_BUDGET_MS - smokeTimeoutMs - TRANSPORT_MARGIN_MS)));
}

if (process.env.FAST_WEBFETCH_SMOKE_URL) {
  runCliSmoke().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
} else {
  const transport = new StdioServerTransport();
  server.connect(transport);
  console.error("Fast WebFetch MCP server v6 running (local Crawl4AI)");
}
