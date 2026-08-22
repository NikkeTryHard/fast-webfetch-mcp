import { CONFIG, readSecretFile } from "./config.js";

async function runGemini(prompt: string, timeoutMs: number): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || readSecretFile(CONFIG.geminiApiKeyFile);
  if (!apiKey) {
    throw new Error("Gemini API key missing");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048 },
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(bodyText || `Gemini request failed with HTTP ${response.status}`);
    }
    return bodyText;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Gemini timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function summarizeContent(content: string, userPrompt: string, timeoutMs: number): Promise<string> {
  const prompt = `Use only the fetched page content below. If the content does not contain the answer, say that clearly. Be concise and cite exact page facts instead of guessing.

Fetched page content:
---
${content}
---

User request:
${userPrompt}`;

  if (timeoutMs < 1_000) {
    return `[Summarization failed: stage=summary error_type=DeadlineExceeded remaining_ms=${timeoutMs}]\n\n${content.slice(0, 5000)}...`;
  }

  try {
    const bodyText = await runGemini(prompt, Math.min(timeoutMs, CONFIG.geminiTimeoutMs));
    const data = JSON.parse(bodyText);
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text)
      .filter(Boolean)
      .join("\n");

    return text || "Gemini returned no text content";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Summarization failed: stage=summary error_type=${error instanceof Error ? error.name : "Error"} timeout_ms=${timeoutMs} message=${message}]\n\n${content.slice(0, 5000)}...`;
  }
}
