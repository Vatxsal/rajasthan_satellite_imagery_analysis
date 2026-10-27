import { NextResponse } from "next/server";
import { z } from "zod";
import { buildSummaryPrompt, SUMMARY_MODEL_FALLBACK, SUMMARY_SYSTEM_PROMPT } from "@/lib/analysis/prompt";
import { aiSummaryCache, summaryCacheKey } from "@/lib/cache";
import { getServerEnv } from "@/lib/env";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Stats payload only — hard cap well under the generic 512 KB JSON limit. */
const SUMMARY_BODY_LIMIT = 32_000;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const sceneMetaSchema = z
  .object({
    date: dateStr,
    cloudCover: z.number().min(0).max(100),
    satellite: z.string().max(64),
    tileCount: z.number().int().min(1).max(999),
  })
  .nullable();

const classStatSchema = z.object({
  code: z.number().int().min(0).max(6),
  label: z.string().max(80),
  color: z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]),
  pixels: z.number().int().min(0),
  areaHa: z.number().min(0),
  areaKm2: z.number().min(0),
  pctOfValid: z.number().min(0).max(100),
});

const hotspotSchema = z.object({
  centroid: z.tuple([z.number(), z.number()]),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  areaHa: z.number().min(0),
  classCode: z.number().int().min(0).max(6),
  classLabel: z.string().max(80),
  tehsilName: z.string().max(120).nullable(),
});

const tehsilRowSchema = z.object({
  tehsilId: z.string().max(80),
  name: z.string().max(120),
  pixelsByClass: z.record(z.number().int().min(0)),
  changedHa: z.number().min(0),
  validPixels: z.number().int().min(0),
  insidePixels: z.number().int().min(0),
});

const metadataSchema = z.object({
  areaName: z.string().max(200),
  areaLevel: z.enum(["district", "tehsil", "ilr"]),
  dateA: dateStr,
  dateB: dateStr,
  gapDays: z.number().int().min(0).max(3660),
  sceneA: sceneMetaSchema,
  sceneB: sceneMetaSchema,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  metersPerPixel: z.number().min(0),
  coarse: z.boolean(),
  sensitivity: z.enum(["low", "medium", "high"]),
  minPatchHa: z.number().min(0.01).max(100),
  thresholds: z.record(z.number()),
  generatedAt: z.string().max(64),
});

const statsSchema = z.object({
  metadata: metadataSchema,
  classes: z.array(classStatSchema).max(20),
  validPct: z.number().min(0).max(100),
  areaHa: z.number().min(0),
  validHa: z.number().min(0),
  changedHa: z.number().min(0),
  tehsils: z.array(tehsilRowSchema).max(500).nullable(),
  hotspots: z.array(hotspotSchema).max(10),
  negligible: z.boolean(),
});

const summaryBodySchema = z.object({ stats: statsSchema });

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/**
 * POST /api/compare/summary
 *
 * Body: { stats } — the deterministic analysis output (validated field by
 * field, 32 KB cap). Gemini only words the numbers; imagery and any user data
 * never leave the server. Missing GEMINI_API_KEY → 503 AI_DISABLED (the UI
 * hides the card from analyze's aiEnabled flag).
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "ai");
  if (guard) return guard;

  try {
    const env = getServerEnv();
    if (!env.GEMINI_API_KEY) {
      throw apiError(503, "AI_DISABLED", "AI summary is not enabled on this deployment.");
    }

    const { stats } = await readJsonBody(
      request,
      (raw) => summaryBodySchema.parse(raw),
      SUMMARY_BODY_LIMIT,
    );

    const model = env.GEMINI_MODEL || SUMMARY_MODEL_FALLBACK;
    const prompt = buildSummaryPrompt(stats);
    const cacheKey = summaryCacheKey(prompt, model);
    const cached = aiSummaryCache.get(cacheKey);
    if (cached) {
      return NextResponse.json({ text: cached.toString("utf8"), cached: true });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SUMMARY_SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 900, temperature: 0.3 },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      console.warn(`[compare:summary] upstream ${response.status}: ${detail}`);
      throw apiError(502, "AI_UPSTREAM_ERROR", "AI summary service returned an error. Try again shortly.");
    }

    const json = (await response.json()) as GeminiResponse;
    const text = (json.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw apiError(502, "AI_UPSTREAM_ERROR", "AI summary service returned an empty response. Try again shortly.");
    }

    aiSummaryCache.set(cacheKey, Buffer.from(text, "utf8"), 1_800);
    return NextResponse.json({ text, cached: false });
  } catch (error) {
    return errorResponse(error);
  }
}
