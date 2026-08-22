import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSeriousFailure, writeErrorLog } from "../src/diagnostics.js";
import { withLog } from "../src/fetchers.js";
import type { WorkerFailure } from "../src/types.js";

const logsDir = mkdtempSync(join(tmpdir(), "fwf-logs-"));
process.env.FAST_WEBFETCH_LOGS_DIR = logsDir;

function failure(stage: WorkerFailure["stage"]): WorkerFailure {
  return { stage, message: "boom", elapsedMs: 5, timeoutMs: 25_000 };
}

describe("isSeriousFailure", () => {
  test("tool-side stages are serious, flaky ones are not", () => {
    for (const stage of ["spawn", "worker", "output"]) expect(isSeriousFailure(stage)).toBe(true);
    for (const stage of ["timeout", "queue"]) expect(isSeriousFailure(stage)).toBe(false);
  });
});

describe("withLog", () => {
  test("serious failure appends log path and writes replayable JSON", () => {
    const out = withLog("fast_fetch", "Crawl4AI python missing: x", failure("spawn"), { url: "https://a" });
    const logLine = out.split("\n").find((l: string) => l.startsWith("log: "));
    expect(logLine).toBeDefined();
    const path = logLine!.slice(5);
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.tool).toBe("fast_fetch");
    expect(record.url).toBe("https://a");
    expect(record.failure.stage).toBe("spawn");
  });

  test("timeout failure stays bare, writes nothing", () => {
    const out = withLog("fast_fetch", "timed out", failure("timeout"), { url: "https://a" });
    expect(out).toBe("timed out");
    expect(out).not.toContain("log:");
  });

  test("missing failure object is a no-op", () => {
    expect(withLog("fast_fetch", "plain", undefined, {})).toBe("plain");
  });
});

describe("writeErrorLog", () => {
  test("returns a readable path inside the redirected dir", () => {
    const path = writeErrorLog("probe", { hello: "world" });
    expect(path).toBeDefined();
    expect(path!.startsWith(logsDir)).toBe(true);
    expect(JSON.parse(readFileSync(path!, "utf8")).hello).toBe("world");
  });
});
