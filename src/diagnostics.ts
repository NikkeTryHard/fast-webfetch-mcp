import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PACKAGE_ROOT } from "./config.js";

const SERIOUS_BY_STAGE: Record<string, true> = {
  spawn: true,
  worker: true,
  output: true,
};

export function isSeriousFailure(stage: string): boolean {
  return SERIOUS_BY_STAGE[stage] === true;
}

export function writeErrorLog(tool: string, payload: Record<string, unknown>): string | undefined {
  // Resolved per call so tests (and callers) can redirect without reload games.
  const logsDir = process.env.FAST_WEBFETCH_LOGS_DIR || join(PACKAGE_ROOT, "logs");
  try {
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(logsDir, `${stamp}-${tool}.json`);
    writeFileSync(path, JSON.stringify({ tool, ...payload }, null, 2));
    return path;
  } catch {
    return undefined; // diagnostics must never break the fetch path
  }
}
