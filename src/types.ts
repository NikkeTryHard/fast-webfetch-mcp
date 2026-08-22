export type WorkerFailure = {
  stage: "queue" | "spawn" | "timeout" | "worker" | "output";
  message: string;
  elapsedMs: number;
  timeoutMs: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stderrTail?: string;
};

export type WorkerRunResult = { ok: true; stdout: string; stderrTail?: string } | { ok: false; failure: WorkerFailure };

export type ScrapeResult = {
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

export type BatchItem =
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
