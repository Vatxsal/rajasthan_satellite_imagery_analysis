/**
 * Minimal Gemini generateContent client (REST) for the AI summary.
 * - structured output (responseMimeType + sanitized responseSchema)
 * - optional â‰¤768 px JPEG preview images as inline parts
 * - distinct upstream error codes (AI_AUTH / AI_MODEL_NOT_FOUND /
 *   AI_BAD_REQUEST / AI_RATE_LIMITED / AI_UNAVAILABLE / AI_BAD_OUTPUT)
 * - one retry with backoff on 429 / 5xx / timeout / bad output
 * - one automatic retry without images when a 400 hits an image request,
 *   then a schema-less JSON-in-prompt fallback (see generateWithFallback)
 * - dev-only logging of the upstream HTTP status + error body (never the key)
 * - errors follow the { status, code } API contract WITHOUT importing
 *   next/server, so the node test build can import this module directly.
 *
 * The transport is injectable (`fetchFn`) for unit tests.
 */

export type SummaryErrorCode =
  | "AI_AUTH"
  | "AI_MODEL_NOT_FOUND"
  | "AI_BAD_REQUEST"
  | "AI_RATE_LIMITED"
  | "AI_UNAVAILABLE"
  | "AI_BAD_OUTPUT";

export function codedError(status: number, code: SummaryErrorCode | string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Marks an error as deterministic (e.g. a 4xx rejection) â€” never retried. */
function nonRetryable<T extends Error>(error: T): T {
  return Object.assign(error, { retryable: false });
}

/** Server-side guard: missing key â†’ AI_DISABLED (503) before any I/O. */
export function assertGeminiKey(apiKey: string | undefined | null): string {
  if (!apiKey) {
    throw codedError(503, "AI_DISABLED", "AI summary is not enabled on this deployment.");
  }
  return apiKey;
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
  responseSchema?: Record<string, unknown>;
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
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
}

/**
 * Pulls the JSON payload out of candidate text. Models occasionally wrap the
 * object in a ```json fence or a prose preamble even with responseSchema —
 * raw JSON.parse alone would reject a perfectly good summary.
 */
function extractJsonPayload(text: string): unknown | undefined {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(trimmed.slice(braceStart, braceEnd + 1));
  }
  const bracketStart = trimmed.indexOf("[");
  const bracketEnd = trimmed.lastIndexOf("]");
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    candidates.push(trimmed.slice(bracketStart, bracketEnd + 1));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}

/**
 * Keywords Gemini's structured-output schema rejects (plain JSON Schema /
 * OpenAPI extras). Only the documented OpenAPI-style subset is forwarded:
 * type, properties, required, items, description, enum, format, nullable,
 * propertyOrdering, minItems, maxItems.
 */
const SCHEMA_ALLOWED_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "description",
  "enum",
  "format",
  "nullable",
  "propertyOrdering",
  "minItems",
  "maxItems",
]);

/**
 * Deep-copies `schema`, dropping every unsupported keyword ($schema, $ref,
 * $defs, additionalProperties, default, examples, allOf/anyOf/â€¦ , â€¦) so a
 * zod-generated or hand-written schema can never trip a Gemini 400.
 */
export function sanitizeResponseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (!SCHEMA_ALLOWED_KEYS.has(key)) continue;
      const child = source[key];
      if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
        const props: Record<string, unknown> = {};
        for (const [name, prop] of Object.entries(child as Record<string, unknown>)) {
          props[name] = walk(prop);
        }
        out[key] = props;
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

function devLog(...parts: unknown[]): void {
  // Server-side only, dev only â€” never sent to the client, never the key.
  if (process.env.NODE_ENV === "development") {
    console.warn("[gemini]", ...parts);
  }
}

/** Upstream status â†’ user-facing message with the contract code (429 handled at the throw site). */
function mapHttpError(status: number): Error {
  if (status === 401 || status === 403) {
    return nonRetryable(
      codedError(502, "AI_AUTH", "The Gemini API key is invalid or lacks access."),
    );
  }
  if (status === 404) {
    return nonRetryable(
      codedError(
        502,
        "AI_MODEL_NOT_FOUND",
        "The configured model is not available; check GEMINI_MODEL (it must appear in the Gemini API model list).",
      ),
    );
  }
  // Remaining 4xx (400 malformed request, 413 payload, â€¦) â€” not retryable.
  return nonRetryable(
    codedError(502, "AI_BAD_REQUEST", "The AI service rejected the summary request."),
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
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: options.maxOutputTokens ?? 4096,
    temperature: options.temperature ?? 0.3,
    responseMimeType: "application/json",
  };
  if (options.responseSchema) {
    generationConfig.responseSchema = sanitizeResponseSchema(options.responseSchema);
  }
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Key travels in a header â€” never in the URL, never logged.
      "x-goog-api-key": options.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      contents: [{ role: "user", parts }],
      generationConfig,
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
      devLog("timeout after", options.timeoutMs ?? 30_000, "ms");
      throw codedError(504, "AI_UNAVAILABLE", "The AI service timed out. Try again shortly.");
    }
    devLog("fetch failed:", (error as Error)?.message ?? String(error));
    throw codedError(502, "AI_UNAVAILABLE", "Could not reach the AI service. Try again shortly.");
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    devLog(`upstream ${response.status} for model ${options.model}:`, bodyText.slice(0, 400));
    if (response.status === 429) {
      const headerRetry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      const bodyRetry = Number.parseInt(
        (bodyText.match(/try again in (\d+)\s*s/i) || [])[1] ?? "",
        10,
      );
      const seconds = Number.isFinite(headerRetry) && headerRetry > 0
        ? headerRetry
        : Number.isFinite(bodyRetry) && bodyRetry > 0
          ? bodyRetry
          : 60;
      const error = codedError(429, "AI_RATE_LIMITED", `Free-tier limit reached; try again in ${seconds} seconds.`);
      throw Object.assign(error, { detail: `HTTP 429: ${bodyText.replace(/\s+/g, " ").slice(0, 200)}` });
    }
    if (response.status >= 500) {
      const error = codedError(502, "AI_UNAVAILABLE", "The AI service is unavailable right now. Try again shortly.");
      throw Object.assign(error, { detail: `HTTP ${response.status}: ${bodyText.replace(/\s+/g, " ").slice(0, 200)}` });
    }
    const error = mapHttpError(response.status);
    throw Object.assign(error, { detail: `HTTP ${response.status}: ${bodyText.replace(/\s+/g, " ").slice(0, 200)}` });
  }

  const raw = await response.text();
  devLog(`upstream 200 for model ${options.model}`);
  let json: GeminiResponseShape;
  try {
    json = JSON.parse(raw) as GeminiResponseShape;
  } catch {
    devLog("response envelope was not JSON:", raw.slice(0, 200));
    throw codedError(502, "AI_BAD_OUTPUT", "AI summary service returned invalid JSON. Try again shortly.");
  }

  const text = (json.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) {
    devLog("empty candidates/text in response");
    throw codedError(502, "AI_BAD_OUTPUT", "AI summary service returned an empty response. Try again shortly.");
  }
  const firstCandidate = (json.candidates ?? [])[0];
  if (firstCandidate?.finishReason && firstCandidate.finishReason !== "STOP") {
    devLog(`candidate finishReason=${firstCandidate.finishReason}`);
  }
  const payload = extractJsonPayload(text);
  if (payload === undefined) {
    devLog("candidate text was not JSON:", text.slice(0, 300));
    throw codedError(502, "AI_BAD_OUTPUT", "AI summary was not valid JSON. Try again shortly.");
  }
  return payload;
}

function isRetryable(err: Error & { status?: number; code?: string; retryable?: boolean }): boolean {
  // Deterministic failures (4xx rejections flagged at the throw site) are
  // never retried. 429 is deliberately NOT retried in-request either: the
  // free-tier generate_content quota is tiny (20 requests), Retry-After is
  // ~60s (far beyond our backoff), and a retried 429 burns double quota while
  // still limited. Timeout, upstream 5xx and bad output are worth one more
  // try with backoff.
  if (err.retryable === false) return false;
  if (err.status && err.status >= 400 && err.status < 500) return false;
  return err.code === "AI_UNAVAILABLE" || err.code === "AI_BAD_OUTPUT";
}

/**
 * Generates a JSON object matching `responseSchema`, retrying retryable
 * failures once (configurable). Returns the PARSED object (unvalidated â€” the
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

/** Prompt suffix used when the responseSchema route keeps failing (400). */
function schemalessPrompt(schema: Record<string, unknown> | undefined, prompt: string): string {
  const shape = schema ? `\n\nRespond with ONLY one JSON object matching this JSON shape (no markdown, no code fences):\n${JSON.stringify(sanitizeResponseSchema(schema))}` : "\n\nRespond with ONLY one JSON object (no markdown, no code fences).";
  return prompt + shape;
}

export interface FallbackResult {
  data: unknown;
  /** True when the successful call was made WITHOUT the requested images. */
  imagesFallback: boolean;
}

/**
 * Calls generateStructuredJson with the spec'd fallback chain:
 * 1. normal call (images + schema);
 * 2. on AI_BAD_REQUEST with images attached â†’ retry once WITHOUT images;
 * 3. on a persistent AI_BAD_REQUEST â†’ retry once without responseSchema,
 *    asking for JSON in the prompt (the caller still validates with zod).
 * Retryable failures (429/5xx/timeout/bad output) are handled inside
 * generateStructuredJson and never enter this chain.
 */
export async function generateWithFallback(options: GenerateJsonOptions): Promise<FallbackResult> {
  const hadImages = (options.images ?? []).length > 0;
  try {
    return { data: await generateStructuredJson(options), imagesFallback: false };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "AI_BAD_REQUEST") throw error;
  }

  if (hadImages) {
    try {
      const data = await generateStructuredJson({ ...options, images: [] });
      return { data, imagesFallback: true };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "AI_BAD_REQUEST") throw error;
    }
  }

  const data = await generateStructuredJson({
    ...options,
    images: [],
    responseSchema: undefined,
    prompt: schemalessPrompt(options.responseSchema, options.prompt),
  });
  return { data, imagesFallback: hadImages };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
