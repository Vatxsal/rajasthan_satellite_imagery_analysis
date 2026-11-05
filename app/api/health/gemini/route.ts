import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { assertGeminiKey, generateStructuredJson } from "@/lib/server/gemini";
import { errorResponse, rateLimitGuard, sameOriginGuard } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 30;

const HEALTH_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: { ok: { type: "STRING" } },
  required: ["ok"],
};

/**
 * GET /api/health/gemini — tiny generateContent probe against the configured
 * model. Returns { ok, model, status } or a mapped error (AI_DISABLED,
 * AI_AUTH, AI_MODEL_NOT_FOUND, AI_RATE_LIMITED, AI_UNAVAILABLE, …).
 * Same-origin + rate-limited (shares the `ai` bucket — each probe costs one
 * free-tier request). Never exposes the key.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "ai");
  if (guard) return guard;

  try {
    const env = getServerEnv();
    const apiKey = assertGeminiKey(env.GEMINI_API_KEY);
    const model = env.GEMINI_MODEL;

    await generateStructuredJson({
      apiKey,
      model,
      systemInstruction: "You are a health check. Reply with the exact JSON you are asked for.",
      prompt: 'Reply with exactly this JSON: {"ok":"yes"}',
      responseSchema: HEALTH_SCHEMA,
      maxOutputTokens: 512,
      timeoutMs: 15_000,
      retries: 0,
    });

    return NextResponse.json(
      { ok: true, model, status: 200 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
