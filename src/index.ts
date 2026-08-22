#!/usr/bin/env bun
/**
 * Crawl4AI-backed MCP server. Markdown fetches go through the local Python worker.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { CONFIG, MAX_CRAWL_TIMEOUT_MS, REQUEST_BUDGET_MS, TRANSPORT_MARGIN_MS, WORKER_REPORT_GRACE_MS, asArgs, readPositiveInt, resolveMaxLength, resolveTimeoutMs } from "./config.js";
import { fetchMarkdown, fetchMarkdownBatch, fetchRawHtml } from "./fetchers.js";
import { metadataHeader, renderSingle } from "./render.js";
import { summarizeContent } from "./summary.js";

const server = new Server(
  { name: "fast-webfetch", version: "1.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fast_fetch",
      description: CONFIG.disableSummary
        ? "Open one known URL and return source-grounded Markdown from local Crawl4AI. Use after search when URL likely contains answer, or when user gives URL. Not web search. Returns fetched page content only; no AI summary. Use full_content when truncation would hide needed facts; timeout capped at 25s."
        : "Open one known URL and return source-grounded Markdown from local Crawl4AI, or answer a specific prompt using only fetched content. Use after search when URL likely contains answer, or when user gives URL. Not web search. With prompt, answer must stay grounded in fetched content and say when content lacks answer. Use full_content when truncation would hide needed facts; timeout capped at 25s.",
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
  console.error("Fast WebFetch MCP server v1.1.0 running (local Crawl4AI)");
}
