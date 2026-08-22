import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { CONFIG, MAX_CRAWL_TIMEOUT_MS, REQUEST_BUDGET_MS, TERMINATE_GRACE_MS, TRANSPORT_MARGIN_MS, WORKER_REPORT_GRACE_MS } from "./config.js";
import { workerPermits } from "./permits.js";
import type { WorkerFailure, WorkerRunResult } from "./types.js";

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;

export async function runWorker(
  input: Record<string, unknown>,
  crawlTimeoutMs: number,
  permitCount = 1,
  outerTimeoutMs = crawlTimeoutMs + WORKER_REPORT_GRACE_MS,
): Promise<WorkerRunResult> {
  const startedAt = Date.now();
  const processTimeoutMs = Math.min(outerTimeoutMs, REQUEST_BUDGET_MS - TRANSPORT_MARGIN_MS);
  const failure = (stage: WorkerFailure["stage"], message: string, extra: Partial<WorkerFailure> = {}): WorkerRunResult => ({
    ok: false,
    failure: { stage, message, elapsedMs: Date.now() - startedAt, timeoutMs: crawlTimeoutMs, ...extra },
  });

  if (!existsSync(CONFIG.crawl4aiWorker)) {
    return failure(
      "spawn",
      `Crawl4AI worker missing: ${CONFIG.crawl4aiWorker} (package_root=${CONFIG.crawl4aiWorker}; expected install at ~/.local/share/mcp/fast-webfetch-mcp — not ~/.config/opencode/mcp/)`,
    );
  }
  if (!existsSync(CONFIG.pythonBin)) {
    return failure("spawn", `Crawl4AI python missing: ${CONFIG.pythonBin} (set FAST_WEBFETCH_PYTHON or recreate .venv)`);
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

/** The Python worker prints progress junk around the result; the last JSON line wins. */
export function parseWorkerJson(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastJsonLine = [...lines].reverse().find((line) => line.startsWith("{") || line.startsWith("["));
  if (!lastJsonLine) {
    throw new Error("worker produced no JSON");
  }
  return JSON.parse(lastJsonLine);
}

