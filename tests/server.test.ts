import { describe, expect, test } from "bun:test";

import { MAX_CRAWL_TIMEOUT_MS, CONFIG, HARD_MAX_LENGTH, resolveMaxLength, resolveTimeoutMs } from "../src/config.js";
import { WorkerPermitPool } from "../src/permits.js";
import { metadataHeader, renderSingle, workerFailureText } from "../src/render.js";
import type { ScrapeResult, WorkerFailure } from "../src/types.js";
import { parseWorkerJson } from "../src/worker.js";

// --- parseWorkerJson -----------------------------------------------------

describe("parseWorkerJson", () => {
  test("selects the array line amid crawl4ai progress junk", () => {
    const stdout = '[INIT].... → Crawl4AI 0.9.2\n[FETCH]... ↓ https://example.com | ✓\n[{"input_url":"https://example.com","status":"ok"}]';
    expect(parseWorkerJson(stdout)).toEqual([{ input_url: "https://example.com", status: "ok" }]);
  });

  test("selects a single object result", () => {
    expect(parseWorkerJson('junk\n{"status":"ok","markdown":"# hi"}')).toEqual({ status: "ok", markdown: "# hi" });
  });

  test("prefers the last JSON-looking line", () => {
    expect(parseWorkerJson('{"old": 1}\n[2]')).toEqual([2]);
  });

  test("tolerates CRLF line endings", () => {
    expect(parseWorkerJson('[1]\r\n')).toEqual([1]);
  });

  test("throws when no JSON present", () => {
    expect(() => parseWorkerJson("no json here at all")).toThrow("worker produced no JSON");
  });
});

// --- arg resolution -------------------------------------------------------

describe("resolveMaxLength", () => {
  test("defaults to CONFIG.maxLength", () => {
    expect(resolveMaxLength({})).toBe(CONFIG.maxLength);
  });

  test("clamps requested above hard max", () => {
    expect(resolveMaxLength({ max_length: 999_999 })).toBe(HARD_MAX_LENGTH);
  });

  test("full_content forces hard max even with small request", () => {
    expect(resolveMaxLength({ max_length: 10, full_content: true })).toBe(HARD_MAX_LENGTH);
  });
});

describe("resolveTimeoutMs", () => {
  test("floors at one second", () => {
    expect(resolveTimeoutMs({ timeout_ms: 5 })).toBe(1_000);
  });

  test("caps at the crawl ceiling", () => {
    expect(resolveTimeoutMs({ timeout_ms: 999_999 })).toBe(MAX_CRAWL_TIMEOUT_MS);
  });

  test("falls back to CONFIG.timeoutMs", () => {
    expect(resolveTimeoutMs({})).toBe(CONFIG.timeoutMs);
  });
});

// --- rendering ------------------------------------------------------------

describe("workerFailureText", () => {
  const base: WorkerFailure = { stage: "timeout", message: "boom", elapsedMs: 12, timeoutMs: 25_000 };

  test("includes stage timing and message", () => {
    const text = workerFailureText(base);
    expect(text).toContain("stage=timeout");
    expect(text).toContain("elapsed_ms=12");
    expect(text).toContain("timeout_ms=25000");
    expect(text.startsWith("boom")).toBe(true);
  });

  test("appends exit code signal and stderr tail when present", () => {
    const text = workerFailureText({ ...base, exitCode: 3, signal: "SIGKILL", stderrTail: "trace" });
    expect(text).toContain("exit_code=3");
    expect(text).toContain("signal=SIGKILL");
    expect(text).toContain('"trace"');
  });
});

describe("metadataHeader", () => {
  test("drops undefined and empty-string fields, flattens newlines", () => {
    const header = metadataHeader({ url: "https://a", status: 200, stage: undefined, error_type: "", truncated: false });
    expect(header.split("\n")).toEqual(["---", "url: https://a", "status: 200", "truncated: false", "---"]);
  });
});

describe("renderSingle", () => {
  test("wraps content with status header and honors truncation metadata", () => {
    const result: ScrapeResult = { success: true, markdown: "# page", metadata: { statusCode: 201, truncated: true } };
    const out = renderSingle(result.markdown ?? "", result);
    expect(out).toContain("status: 201");
    expect(out).toContain("truncated: true");
    expect(out.endsWith("# page")).toBe(true);
  });
});

// --- permit pool -----------------------------------------------------------

describe("WorkerPermitPool", () => {
  test("grants up to capacity and restores on release", async () => {
    const pool = new WorkerPermitPool(2);
    const a = await pool.acquire(1, 100);
    const b = await pool.acquire(1, 100);
    expect(a?.count).toBe(1);
    expect(b?.count).toBe(1);
    const c = await pool.acquire(1, 10);
    expect(c).toBeUndefined(); // exhausted -> queue times out
    b?.release();
    const d = await pool.acquire(1, 10);
    expect(d?.count).toBe(1);
  });

  test("grants partially when demand exceeds free slots, tops up after release", async () => {
    const pool = new WorkerPermitPool(3);
    const first = await pool.acquire(2, 100);
    expect(first?.count).toBe(2);

    // Only 1 slot left -> immediate PARTIAL grant of 1, not queueing.
    const partial = await pool.acquire(2, 5_000);
    expect(partial?.count).toBe(1);
    // Free everything, then a full 2-slot demand succeeds.
    first?.release();
    partial?.release();
    const full = await pool.acquire(2, 5_000);
    expect(full?.count).toBe(2);
    full?.release();
  });

  test("double release is idempotent", async () => {
    const pool = new WorkerPermitPool(1);
    const lease = await pool.acquire(1, 10);
    lease?.release();
    lease?.release();
    const again = await pool.acquire(1, 10);
    expect(again?.count).toBe(1);
  });
});
