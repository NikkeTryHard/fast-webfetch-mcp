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

// Default max content length (characters)
const DEFAULT_MAX_LENGTH = 100000;

// Firecrawl config
const FIRECRAWL_API_URL = process.env.FIRECRAWL_API_URL || "http://localhost:3002";

// AI summarization config
const AI_API_URL = process.env.FAST_WEBFETCH_API_URL || "http://127.0.0.1:8045/v1";
const AI_MODEL = process.env.FAST_WEBFETCH_MODEL || "gemini-3-flash";

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
    const response = await fetch(`${AI_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
  const { timeout = 30000 } = options;
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
  const { formats = ["markdown"], onlyMainContent = true, timeout = 30000 } = options;

  // Try Firecrawl first
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
    }
  } catch {
    // Firecrawl not available, fall through to fallback
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
      error: message,
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

        // For JSON, we use direct fetch since Firecrawl is for HTML
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": getRandomUserAgent(),
          },
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error: HTTP ${response.status} fetching ${url}`,
              },
            ],
            isError: true,
          };
        }

        const json = await response.json();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(json, null, 2),
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

        const output = results
          .map((result, i) => {
            if (result.status === "rejected") {
              return `## ${urls[i]}\n\nError: ${result.reason}`;
            }

            const { url, title, content, error } = result.value as any;

            if (error) {
              return `## ${url}\n\nError: ${error}`;
            }

            return `## ${title || url}\n\n**URL:** ${url}\n\n${content}`;
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
