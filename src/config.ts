import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_MAX_LENGTH = 40_000; // about 10k tokens for typical English/Markdown
export const HARD_MAX_LENGTH = 100_000;
export const MAX_CRAWL_TIMEOUT_MS = 25_000;
export const REQUEST_BUDGET_MS = 29_000;
export const TRANSPORT_MARGIN_MS = 1_000;
export const WORKER_REPORT_GRACE_MS = 2_500;
export const TERMINATE_GRACE_MS = 500;

export function readPositiveInt(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export function readSecretFile(path: string): string {
  const expandedPath = path.startsWith("~/") ? `${process.env.HOME || ""}/${path.slice(2)}` : path;
  try {
    return readFileSync(expandedPath, "utf8").trim();
  } catch {
    return "";
  }
}

export const CONFIG = {
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

export function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function resolveMaxLength(args: Record<string, unknown>): number {
  const requested = positiveNumber(args.max_length);
  const target = args.full_content === true ? CONFIG.hardMaxLength : (requested ?? CONFIG.maxLength);
  return Math.max(1, Math.min(target, CONFIG.hardMaxLength));
}

export function resolveTimeoutMs(args: Record<string, unknown>): number {
  const requested = positiveNumber(args.timeout_ms);
  return Math.max(1_000, Math.min(requested ?? CONFIG.timeoutMs, MAX_CRAWL_TIMEOUT_MS));
}
