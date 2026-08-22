import type { ScrapeResult, WorkerFailure } from "./types.js";

export function workerFailureText(failure: WorkerFailure): string {
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

export function metadataHeader(fields: Record<string, string | number | boolean | undefined>): string {
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${key}: ${String(value).replace(/\n/g, " ")}`);
  return `---\n${lines.join("\n")}\n---`;
}

export function renderSingle(content: string, result: ScrapeResult, truncated = result.metadata?.truncated ?? false): string {
  const meta = result.metadata ?? {};
  return `${metadataHeader({
    status: meta.statusCode ?? 200,
    truncated,
  })}\n\n${content}`;
}
