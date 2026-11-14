import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildSummaryPrompt,
  SUMMARY_IMAGES_NOTE,
  SUMMARY_MODEL_FALLBACK,
  SUMMARY_RESPONSE_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  summaryLanguageLine,
  summaryOutputSchema,
  type SummaryOutput,
} from "@/lib/analysis/prompt";
import { aiSummaryCache, summaryCacheKey } from "@/lib/cache";
import { getServerEnv } from "@/lib/env";
import { authorize, consumeRoleQuota, forbiddenRoleResponse } from "@/lib/auth/guard";
import { bumpGlobalCounter } from "@/lib/auth/quota";
import { can } from "@/lib/auth/permissions";
import {
  assertGeminiKey,
  codedError,
  generateWithFallback,
  type GeminiImagePart,
} from "@/lib/server/gemini";
import { entryForKey } from "@/lib/server/compareRun";
import { buildSummaryImages } from "@/lib/server/summaryImages";
import {
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 60;

const SUMMARY_BODY_LIMIT = 8_000;
const SUMMARY_TTL_SECONDS = 1_800;

const summaryBodySchema = z.object({
  /** Key returned by /api/compare/analyze — the cached artifact is looked up by it. */
  analysisKey: z.string().trim().min(8).max(128),
  language: z.enum(["en", "hi"]).default("en"),
  includeImages: z.boolean().default(true),
  // Optional analysis parameters — with them the server recomputes a cold
  // artifact instead of failing with ANALYSIS_EXPIRED (same contract as the
  // events/overlay routes); without them the legacy cache-only path applies.
  areaId: z.string().optional(),
  level: z.enum(["district", "tehsil", "ilr"]).optional(),
  dateA: z.string().optional(),
  dateB: z.string().optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
  minPatchHa: z.coerce.number().optional(),
  inputMode: z.enum(["single", "composite"]).optional(),
  compositeWindowDays: z.coerce.number().int().optional(),
});

type SummaryBody = z.infer<typeof summaryBodySchema>;

const IMAGE_LABELS = [
  "Image 1 — date A (true colour):",
  "Image 2 — date B (true colour):",
  "Image 3 — classified change overlay on date B:",
];

function userPrompt(
  body: SummaryBody,
  stats: Parameters<typeof buildSummaryPrompt>[0],
  events?: Parameters<typeof buildSummaryPrompt>[1],
): string {
  const lines = [summaryLanguageLine(body.language), "", buildSummaryPrompt(stats, events)];
  if (body.includeImages) lines.push("", SUMMARY_IMAGES_NOTE);
  return lines.join("\n");
}

/**
 * POST /api/compare/summary
 *
 * Body: { analysisKey, language?, includeImages?, …analysis params }. The
 * deterministic stats are looked up server-side — the client never sends
 * numbers. An already-generated summary is served straight from cache; a
 * cold artifact with analysis parameters recomputes statelessly (can take
 * as long as an analysis run); key-only bodies keep the legacy 404
 * ANALYSIS_EXPIRED contract.
 * With includeImages the server attaches three ≤768 px JPEG previews (date A,
 * date B, overlay-on-B); without, only the whitelisted statistics are sent.
 * Gemini returns structured JSON (schema-enforced), validated with zod and
 * cached by hash(analysisKey + language + includeImages).
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "ai");
  if (guard) return guard;

  // SSO-only capability (403 for guests) + daily AI quota (429), both before
  // any Gemini work so locked/exhausted requests never touch the API key.
  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  if (!can(auth.role, "ai.summary")) return forbiddenRoleResponse("ai.summary");

  try {
    const env = getServerEnv();

    const body = await readJsonBody(request, (raw) => summaryBodySchema.parse(raw), SUMMARY_BODY_LIMIT);

    const quotaDenied = consumeRoleQuota(auth, "aiSummary");
    if (quotaDenied) return quotaDenied;

    const apiKey = assertGeminiKey(env.GEMINI_API_KEY);

    const model = env.GEMINI_MODEL || SUMMARY_MODEL_FALLBACK;
    const cacheKey = summaryCacheKey(body);
    const cached = aiSummaryCache.get(cacheKey);
    if (cached) {
      // Envelope { summary, imagesFallback }; plain summaries written by
      // older builds are tolerated (no fallback flag).
      const parsed = JSON.parse(cached.toString("utf8")) as SummaryOutput | { summary?: SummaryOutput; imagesFallback?: boolean };
      const envelope = typeof (parsed as { summary?: unknown }).summary === "object" && (parsed as { summary?: unknown }).summary !== null;
      const summary = envelope ? (parsed as { summary: SummaryOutput }).summary : (parsed as SummaryOutput);
      const imagesFallback = envelope ? Boolean((parsed as { imagesFallback?: boolean }).imagesFallback) : false;
      return NextResponse.json({ summary, cached: true, model, imageCount: 0, imagesFallback });
    }

    const artifact = await entryForKey(body.analysisKey, body, { role: auth.role });

    let images: GeminiImagePart[] = [];
    if (body.includeImages) {
      const built = await buildSummaryImages({
        geometry: artifact.geometry,
        dateA: artifact.stats.metadata.dateA,
        dateB: artifact.stats.metadata.dateB,
        overlayPng: artifact.overlayPng,
      });
      images = built.map((image) => ({ mimeType: image.mimeType, data: image.data }));
    }

    const options = {
      apiKey,
      model,
      systemInstruction: SUMMARY_SYSTEM_PROMPT,
      prompt: userPrompt(body, artifact.stats, artifact.events),
      responseSchema: SUMMARY_RESPONSE_SCHEMA,
      images,
      imageLabels: IMAGE_LABELS,
      timeoutMs: 45_000,
    };

    // Structured output is schema-guided, but validate + one fresh attempt
    // guards against occasional malformed payloads. generateWithFallback
    // implements the 400-with-images retry (statistics-only note) and the
    // schema-less JSON-in-prompt fallback.
    let summary: SummaryOutput | null = null;
    let lastValidationError: z.ZodError | null = null;
    let imagesFallback = false;
    for (let attempt = 0; attempt < 2 && !summary; attempt++) {
      const generated = await generateWithFallback(options);
      imagesFallback = generated.imagesFallback;
      const result = summaryOutputSchema.safeParse(generated.data);
      if (result.success) {
        summary = result.data;
      } else {
        lastValidationError = result.error;
      }
    }
    if (!summary) {
      console.warn(`[compare:summary] invalid model output: ${lastValidationError?.issues.slice(0, 3).map((i) => i.message).join("; ")}`);
      throw codedError(502, "AI_BAD_OUTPUT", "AI summary had an unexpected shape. Try again shortly.");
    }

    aiSummaryCache.set(
      cacheKey,
      Buffer.from(JSON.stringify({ summary, imagesFallback }), "utf8"),
      SUMMARY_TTL_SECONDS,
    );
    bumpGlobalCounter("ai");
    return NextResponse.json({ summary, cached: false, model, imageCount: images.length, imagesFallback });
  } catch (error) {
    return errorResponse(error);
  }
}
