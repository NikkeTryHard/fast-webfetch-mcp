#!/usr/bin/env bun
/**
 * Fast WebFetch MCP Server
 * High-performance web fetching for Claude Code using Firecrawl backend
 * With fallback to direct fetch + Readability when Firecrawl is unavailable
 * With AI summarization via local LLM API
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { spawn } from "node:child_process";

// Default max content length (characters)
const DEFAULT_MAX_LENGTH = 100000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

// Firecrawl config
const FIRECRAWL_API_URL = process.env.FIRECRAWL_API_URL || "http://localhost:3002";

// AI summarization config
const AI_API_URL = process.env.FAST_WEBFETCH_API_URL || "http://127.0.0.1:8045/v1";
const AI_MODEL = process.env.FAST_WEBFETCH_MODEL || "gemini-3-flash";
const AI_API_KEY = process.env.FAST_WEBFETCH_API_KEY || process.env.OPENAI_API_KEY || "";
const USE_RUST_BACKEND = process.env.FAST_WEBFETCH_USE_RUST === "1";
const RUST_BACKEND_BIN = process.env.FAST_WEBFETCH_RUST_BIN || "";

// User agents for fallback fetch
const USER_AGENTS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"];

// Turndown service for HTML to Markdown conversion (fallback)
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.remove(["script", "style", "nav", "footer", "aside", "noscript", "iframe"]);

/**
 * Get a random user agent
 */
function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Summarize content using local LLM API (OpenAI-compatible)
 */
async function summarizeContent(content: string, userPrompt: string): Promise<string> {
  const prompt = `Web page content:
---
${content}
---

${userPrompt}

Provide a concise response based only on the content above.`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (AI_API_KEY) {
      headers.Authorization = `Bearer ${AI_API_KEY}`;
    }

    const response = await fetch(`${AI_API_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI API returned ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Failed to generate summary";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Summarization failed: ${message}]\n\n${content.slice(0, 5000)}...`;
  }
}

async function callRustBackend(url: string, maxLength: number): Promise<ScrapeResult | null> {
  if (!USE_RUST_BACKEND || !RUST_BACKEND_BIN) return null;

  return await new Promise((resolve) => {
    const input = JSON.stringify({
      url,
      max_length: maxLength,
      max_bytes: DEFAULT_MAX_BYTES,
    });

    const child = spawn(RUST_BACKEND_BIN, [], {
      env: {
        ...process.env,
        FAST_WEBFETCH_INPUT: input,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", () => resolve(null));

    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const markdown = typeof parsed.markdown === "string" ? parsed.markdown : "";
        const title = typeof parsed.title === "string" ? parsed.title : "";
        const finalUrl = typeof parsed.url === "string" ? parsed.url : url;
        const statusCode = typeof parsed.status === "number" ? parsed.status : 200;
        const backend = parsed.backend === "firecrawl" ? "firecrawl" : "fallback";

        if (!markdown) {
          resolve(null);
          return;
        }

        resolve({
          success: true,
          markdown,
          metadata: {
            title,
            sourceURL: finalUrl,
            statusCode,
          },
          usedFallback: backend !== "firecrawl",
        });
      } catch {
        if (stderr.trim()) {
          resolve({ success: false, error: stderr.trim() });
          return;
        }
        resolve(null);
      }
    });
  });
}

/**
 * Middle-truncate content to preserve beginning and end
 */
function middleTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const halfLength = Math.floor((maxLength - 100) / 2);
  const start = text.slice(0, halfLength);
  const end = text.slice(-halfLength);
  const truncatedChars = text.length - maxLength;

  return `${start}\n\n... [truncated ${truncatedChars} characters] ...\n\n${end}`;
}

/**
 * Convert HTML to Markdown
 */
function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html);
  } catch {
    return html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

/**
 * Extract main content using Mozilla Readability (fallback)
 */
function extractContent(html: string, url: string): { title: string; content: string; excerpt: string; byline: string | null } | null {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      return null;
    }

    return {
      title: article.title || "",
      content: article.content || "",
      excerpt: article.excerpt || "",
      byline: article.byline,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback: Fetch URL directly with browser UA
 */
async function directFetch(url: string, options: { timeout?: number } = {}): Promise<{ html: string; status: number; finalUrl: string }> {
  const { timeout = DEFAULT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    const html = await response.text();
    return {
      html,
      status: response.status,
      finalUrl: response.url,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function directFetchJson(url: string, timeout = DEFAULT_TIMEOUT_MS): Promise<{ status: number; data?: unknown; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": getRandomUserAgent(),
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      return { status: response.status, error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    if (text.length > DEFAULT_MAX_BYTES) {
      return { status: 413, error: `Response too large (${text.length} bytes)` };
    }

    try {
      return { status: response.status, data: JSON.parse(text) };
    } catch {
      return { status: response.status, error: "Invalid JSON response" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Scrape result type
type ScrapeResult = {
  success: boolean;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
  };
  error?: string;
  usedFallback?: boolean;
};

/**
 * Fetch URL using Firecrawl API with fallback to direct fetch
 */
async function scrapeUrl(
  url: string,
  options: {
    formats?: string[];
    onlyMainContent?: boolean;
    timeout?: number;
  } = {},
): Promise<ScrapeResult> {
  const { formats = ["markdown"], onlyMainContent = true, timeout = DEFAULT_TIMEOUT_MS } = options;

  if (formats.length === 1 && formats[0] === "markdown") {
    const rustResult = await callRustBackend(url, DEFAULT_MAX_LENGTH);
    if (rustResult?.success) {
      return rustResult;
    }
  }

  // Try Firecrawl first
  let firecrawlErrorMessage = "";
  try {
    const response = await fetch(`${FIRECRAWL_API_URL}/v1/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats,
        onlyMainContent,
        timeout,
      }),
    });

    if (response.ok) {
      const data = await response.json();

      if (data.success) {
        return {
          success: true,
          markdown: data.data?.markdown,
          html: data.data?.html,
          rawHtml: data.data?.rawHtml,
          links: data.data?.links,
          metadata: data.data?.metadata,
          usedFallback: false,
        };
      }
    } else {
      firecrawlErrorMessage = `Firecrawl HTTP ${response.status}`;
    }
  } catch (error) {
    firecrawlErrorMessage = error instanceof Error ? error.message : String(error);
  }

  // Fallback: Direct fetch with Readability
  try {
    const { html, status, finalUrl } = await directFetch(url, { timeout });

    if (status >= 400) {
      return {
        success: false,
        error: `HTTP ${status}`,
      };
    }

    // Check if raw HTML was requested
    if (formats.includes("rawHtml")) {
      return {
        success: true,
        rawHtml: html,
        metadata: {
          sourceURL: finalUrl,
          statusCode: status,
        },
        usedFallback: true,
      };
    }

    // Extract content with Readability
    const article = extractContent(html, finalUrl);
    let markdown: string;
    let title = "";

    if (article) {
      title = article.title;
      markdown = htmlToMarkdown(article.content);
    } else {
      markdown = htmlToMarkdown(html);
    }

    return {
      success: true,
      markdown,
      metadata: {
        title,
        sourceURL: finalUrl,
        statusCode: status,
      },
      usedFallback: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: firecrawlErrorMessage ? `Firecrawl failed (${firecrawlErrorMessage}); fallback failed (${message})` : message,
    };
  }
}

// Create MCP server
const server = new Server(
  {
    name: "fast-webfetch",
    version: "2.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "fast_fetch",
        description: "Fetch a URL using Firecrawl (with fallback to direct fetch). If a prompt is provided, uses AI to summarize the content. Works with sites that block Claude's native WebFetch (Reddit, Twitter, etc.) and extracts comments/dynamic content when Firecrawl is available.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch",
            },
            prompt: {
              type: "string",
              description: "What information to look for - AI will summarize content based on this prompt",
            },
            max_length: {
              type: "number",
              description: `Maximum content length in characters (default ${DEFAULT_MAX_LENGTH})`,
            },
            include_links: {
              type: "boolean",
              description: "Include hyperlinks in the markdown output (default: true)",
            },
            no_summarize: {
              type: "boolean",
              description: "Skip AI summarization even if prompt is provided (return raw markdown)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "fast_fetch_raw",
        description: "Fetch a URL and return raw HTML. Useful for debugging or when you need the original page structure.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch",
            },
            max_length: {
              type: "number",
              description: `Maximum content length in characters (default ${DEFAULT_MAX_LENGTH})`,
            },
          },
          required: ["url"],
        },
      },
      {
        name: "fast_fetch_json",
        description: "Fetch a URL that returns JSON and parse it.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch (should return JSON)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "fast_fetch_multiple",
        description: "Fetch multiple URLs in parallel and return all results.",
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Array of URLs to fetch",
            },
            max_length: {
              type: "number",
              description: `Maximum content length per URL in characters (default ${DEFAULT_MAX_LENGTH})`,
            },
          },
          required: ["urls"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: args } = request.params;

  try {
    switch (toolName) {
      case "fast_fetch": {
        const url = args.url as string;
        const maxLength = (args.max_length as number) || DEFAULT_MAX_LENGTH;
        const includeLinks = args.include_links !== false;
        const userPrompt = args.prompt as string | undefined;
        const noSummarize = args.no_summarize as boolean;

        const result = await scrapeUrl(url, {
          formats: ["markdown"],
          onlyMainContent: true,
        });

        if (!result.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching ${url}: ${result.error}`,
              },
            ],
            isError: true,
          };
        }

        let markdown = result.markdown || "";
        const title = result.metadata?.title || "";
        const finalUrl = result.metadata?.sourceURL || url;
        const backend = result.usedFallback ? "fallback" : "firecrawl";

        // Remove links if requested
        if (!includeLinks) {
          markdown = markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        }

        // Truncate if needed
        markdown = middleTruncate(markdown, maxLength);

        // If prompt provided and not skipping summarization, use AI to summarize
        if (userPrompt && !noSummarize) {
          const summary = await summarizeContent(markdown, userPrompt);
          return {
            content: [
              {
                type: "text",
                text: `# ${title || "Fetched Content"}\n**URL:** ${finalUrl}\n**Backend:** ${backend}\n\n${summary}`,
              },
            ],
          };
        }

        const output = [`# ${title || "Fetched Content"}`, `**URL:** ${finalUrl}`, `**Backend:** ${backend}`, "", markdown].join("\n");

        return {
          content: [{ type: "text", text: output }],
        };
      }

      case "fast_fetch_raw": {
        const url = args.url as string;
        const maxLength = (args.max_length as number) || DEFAULT_MAX_LENGTH;

        const result = await scrapeUrl(url, {
          formats: ["rawHtml"],
          onlyMainContent: false,
        });

        if (!result.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching ${url}: ${result.error}`,
              },
            ],
            isError: true,
          };
        }

        const html = result.rawHtml || "";
        const finalUrl = result.metadata?.sourceURL || url;
        const statusCode = result.metadata?.statusCode || 200;
        const backend = result.usedFallback ? "fallback" : "firecrawl";

        const truncatedHtml = middleTruncate(html, maxLength);

        return {
          content: [
            {
              type: "text",
              text: `URL: ${finalUrl}\nStatus: ${statusCode}\nBackend: ${backend}\n\n${truncatedHtml}`,
            },
          ],
        };
      }

      case "fast_fetch_json": {
        const url = args.url as string;

        const jsonResult = await directFetchJson(url);
        if (jsonResult.error || typeof jsonResult.data === "undefined") {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${jsonResult.error || "Unknown error"} fetching ${url}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(jsonResult.data, null, 2),
            },
          ],
        };
      }

      case "fast_fetch_multiple": {
        const urls = args.urls as string[];
        const maxLength = (args.max_length as number) || DEFAULT_MAX_LENGTH;

        const results = await Promise.allSettled(
          urls.map(async (url) => {
            const result = await scrapeUrl(url, {
              formats: ["markdown"],
              onlyMainContent: true,
            });

            if (!result.success) {
              return { url, error: result.error };
            }

            let markdown = result.markdown || "";
            const title = result.metadata?.title || "";
            const finalUrl = result.metadata?.sourceURL || url;

            markdown = middleTruncate(markdown, Math.floor(maxLength / urls.length));

            return { url: finalUrl, title, content: markdown };
          }),
        );

        type MultiFetchItem =
          | { url: string; error: string }
          | { url: string; title: string; content: string };

        const output = results
          .map((result, i) => {
            if (result.status === "rejected") {
              return `## ${urls[i]}\n\nError: ${result.reason}`;
            }

            const item = result.value as MultiFetchItem;

            if ("error" in item) {
              return `## ${item.url}\n\nError: ${item.error}`;
            }

            return `## ${item.title || item.url}\n\n**URL:** ${item.url}\n\n${item.content}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: output }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport);
console.error("Fast WebFetch MCP server v2.1 running (Firecrawl + fallback)");
