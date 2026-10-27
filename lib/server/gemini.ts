/**
 * Minimal Gemini generateContent client (REST) for the AI summary.
 * - structured output (responseMimeType + responseSchema)
 * - optional ≤768 px JPEG preview images as inline parts
 * - one retry on 429 / 5xx / timeout / bad output with a short backoff
 * - errors follow the { status, code } API contract WITHOUT importing
 *   next/server, so the node test build can import this module directly.
 *
 * The transport is injectable (`fetchFn`) for unit tests.
 */

export type SummaryErrorCode =
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_UPSTREAM_ERROR"
  | "AI_BAD_OUTPUT";

export function codedError(status: number, code: SummaryErrorCode | string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

export interface GeminiImagePart {
  mimeType: string;
  /** Base64 payload. */
  data: string;
}

export interface GenerateJsonOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
  /** Preview images appended after their labels (optional). */
  images?: GeminiImagePart[];
  /** One label text part before each image. */
  imageLabels?: string[];
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Extra tries after the first on retryable failures (default 1). */
  retries?: number;
  /** Backoff between tries (default 1200 ms; tests pass 0). */
  retryDelayMs?: number;
  fetchFn?: typeof fetch;
}

interface GeminiResponseShape {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: Error & { status?: number; code?: string }): boolean {
  return (
    err.code === "AI_TIMEOUT" ||
    err.code === "AI_RATE_LIMITED" ||
    err.code === "AI_UPSTREAM_ERROR" ||
    err.code === "AI_BAD_OUTPUT"
  );
}

/** Performs ONE generateContent call; throws coded transport/output errors. */
async function callOnce(
  options: GenerateJsonOptions,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const parts: unknown[] = [{ text: options.prompt }];
  const labels = options.imageLabels ?? [];
  (options.images ?? []).forEach((image, index) => {
    const label = labels[index];
    if (label) parts.push({ text: label });
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": options.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: options.maxOutputTokens ?? 1600,
        temperature: options.temperature ?? 0.3,
        responseMimeType: "application/json",
        responseSchema: options.responseSchema,
      },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  };

  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw codedError(504, "AI_TIMEOUT", "The AI service timed out. Try again shortly.");
    }
    throw codedError(502, "AI_UPSTREAM_ERROR", "Could not reach the AI service. Try again shortly.");
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429) {
      throw codedError(
        429,
        "AI_RATE_LIMITED",
        `AI service rate limit hit.${retryAfter ? ` Retry in ${retryAfter}s.` : " Try again in a minute."}`,
      );
    }
    if (response.status >= 500) {
      throw codedError(502, "AI_UPSTREAM_ERROR", "AI service returned an error. Try again shortly.");
    }
    // 4xx (bad model id, revoked key, malformed request) — not retryable.
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    console.warn(`[compare:summary] upstream ${response.status}: ${detail}`);
    throw codedError(502, "AI_UPSTREAM_ERROR", "AI summary service rejected the request. Try again shortly.");
  }

  const raw = await response.text();
  let json: GeminiResponseShape;
  try {
    json = JSON.parse(raw) as GeminiResponseShape;
  } catch {
    throw codedError(502, "AI_BAD_OUTPUT", "AI summary service returned invalid JSON. Try again shortly.");
  }

  const text = (json.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw codedError(502, "AI_BAD_OUTPUT", "AI summary service returned an empty response. Try again shortly.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw codedError(502, "AI_BAD_OUTPUT", "AI summary was not valid JSON. Try again shortly.");
  }
}

/**
 * Generates a JSON object matching `responseSchema`, retrying retryable
 * failures once (configurable). Returns the PARSED object (unvalidated — the
 * caller applies the zod schema and may re-call with a fresh attempt).
 */
export async function generateStructuredJson(options: GenerateJsonOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const attempts = 1 + Math.max(0, options.retries ?? 1);
  const backoff = options.retryDelayMs ?? 1200;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await callOnce(options, fetchFn);
    } catch (error) {
      lastError = error;
      const err = error as Error & { status?: number; code?: string };
      if (!isRetryable(err) || attempt === attempts - 1) break;
      await delay(backoff);
    }
  }
  throw lastError;
}
