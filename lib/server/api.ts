import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { checkRateLimit, type RateLimitKind } from "@/lib/rateLimit";

export interface ApiErrorBody {
  code: string;
  message: string;
}

export function jsonError(status: number, code: string, message: string): NextResponse<ApiErrorBody> {
  return NextResponse.json({ code, message }, { status });
}

/** Builds an Error carrying the { status, code } contract for errorResponse(). */
export function apiError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Maximum accepted JSON request body (pre-compiled GeoJSON clip is the largest legitimate payload). */
export const MAX_JSON_BODY_BYTES = 512_000;

/**
 * Reads and validates a JSON request body with a hard size cap.
 * Throws contract errors (413/400) or ZodErrors — both mapped by errorResponse().
 */
export async function readJsonBody<T>(
  request: Request,
  parse: (raw: unknown) => T,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw apiError(413, "PAYLOAD_TOO_LARGE", `Request body too large (limit ${maxBytes} bytes).`);
  }

  const text = await request.text();
  if (text.length > maxBytes) {
    throw apiError(413, "PAYLOAD_TOO_LARGE", `Request body too large (limit ${maxBytes} bytes).`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  return parse(raw);
}

/**
 * Blocks browser requests whose Origin header points at another host
 * (CSRF hardening for POST routes). Non-browser clients without an Origin
 * header pass through — they are covered by rate limiting + validation instead.
 */
export function sameOriginGuard(request: Request): NextResponse<ApiErrorBody> | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  if (origin === "null") {
    return jsonError(403, "CROSS_ORIGIN", "Cross-origin requests are not allowed.");
  }
  try {
    if (new URL(origin).host === new URL(request.url).host) return null;
  } catch {
    return jsonError(403, "CROSS_ORIGIN", "Cross-origin requests are not allowed.");
  }
  return jsonError(403, "CROSS_ORIGIN", "Cross-origin requests are not allowed.");
}

/**
 * Applies per-IP rate limiting; returns a 429 response or null when allowed.
 */
export function rateLimitGuard(
  request: Request,
  kind: RateLimitKind = "api",
): NextResponse<ApiErrorBody> | null {
  const result = checkRateLimit(request, kind);
  if (result.ok) return null;
  return NextResponse.json(
    {
      code: "RATE_LIMITED",
      message: `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
    } satisfies ApiErrorBody,
    {
      status: 429,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    },
  );
}

const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * Serves a binary body as a chunked stream (no Content-Length).
 * Vercel's 4.5 MB response cap applies to buffered responses only — streaming
 * responses are exempt (vercel.com/docs/errors/FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE),
 * which is what keeps large imagery downloads working on the free tier.
 */
export function binaryStreamResponse(buffer: Uint8Array, headers: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < buffer.byteLength; offset += STREAM_CHUNK_BYTES) {
        controller.enqueue(new Uint8Array(buffer.subarray(offset, offset + STREAM_CHUNK_BYTES)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

/** Maps validation and upstream failures to the { code, message } contract. */
export function errorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof ZodError) {
    const detail = error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return jsonError(400, "INVALID_REQUEST", detail);
  }

  const err = error as { status?: number; code?: string; message?: string };
  if (err && typeof err.status === "number" && typeof err.code === "string") {
    return jsonError(err.status, err.code, err.message ?? "Request failed.");
  }

  // Configuration problems (missing CDSE_* vars) surface clearly without secrets.
  if (err instanceof Error && err.message.startsWith("Invalid environment configuration")) {
    return jsonError(500, "CDSE_CONFIG", err.message);
  }

  return jsonError(502, "UPSTREAM_ERROR", "Imagery service request failed. Try again shortly.");
}
