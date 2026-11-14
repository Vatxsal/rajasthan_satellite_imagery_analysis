import { z } from "zod";
import { bboxPolygon } from "@turf/turf";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import { dataSource, getServerEnv } from "@/lib/env";
import { requireCapability } from "@/lib/auth/guard";
import { bboxAreaKm2 } from "@/lib/cdse/geometry";
import {
  fieldsCache,
  fieldsCacheKey,
  FIELDS_CACHE_TTL_SECONDS,
  patternCache,
  patternCacheKey,
} from "@/lib/cache";
import { fetchAnalysisRaster } from "@/lib/analysis/fetch";
import { NDVI_MONTH_EVALSCRIPT } from "@/lib/analysis/evalscript";
import { parseNdviMonthRaster } from "@/lib/analysis/parse";
import { readConfidenceWindow } from "@/lib/fields/confidence";
import {
  buildFieldsRaw,
  filterFields,
  httpRangeReader,
  isContractError,
  type FieldsYear,
} from "@/lib/fields/query";
import { estimatePatternPu, preparePatternGrid, type PatternMonth } from "@/lib/fields/pattern";
import { runPattern, type PatternResult } from "@/lib/fields/patternRun";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Mock-mode refusal for this endpoint (compareRun's wording is change-specific). */
const MOCK_PATTERN_MESSAGE =
  "The cropping-pattern demo needs live Sentinel-2 data — set NEXT_PUBLIC_DATA_SOURCE=cdse with CDSE credentials.";

const patternRequestSchema = z.object({
  bbox: z
    .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
    .refine(
      ([west, south, east, north]) =>
        west < east && south < north && Math.abs(south) < 85 && Math.abs(north) < 85,
      {
        message:
          "bbox must be [west, south, east, north] with west < east, south < north and |latitude| < 85",
      },
    ),
  year: z
    .coerce.number()
    .int()
    .refine((value) => value === 2024 || value === 2025, { message: "year must be 2024 or 2025" }),
  minConfidence: z.coerce.number().int().min(0).max(100).optional(),
  /** Optional override of the FIELDS_GROUPING default (JSON boolean, no coercion). */
  grouping: z.boolean().optional(),
});

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
} as const;

type SendFrame = (frame: unknown) => void;

/** Wraps an async frame writer in the shared NDJSON stream + error contract. */
function ndjsonResponse(write: (send: SendFrame) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SendFrame = (frame) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      try {
        await write(send);
        controller.close();
      } catch (error) {
        console.error(
          "[fields:pattern] failed:",
          error instanceof Error ? `${error.name}: ${error.message}` : error,
        );
        try {
          send({ type: "error", ...streamErrorBody(error) });
          controller.close();
        } catch {
          // client disconnected — nothing left to do
        }
      }
    },
  });
  return new Response(stream, { status: 200, headers: NDJSON_HEADERS });
}

/** Maps mid-stream failures to the { code, message } contract (no HTTP status once streaming). */
function streamErrorBody(error: unknown): { code: string; message: string } {
  const err = error as { code?: unknown; message?: unknown };
  if (err && typeof err.code === "string") {
    return {
      code: err.code,
      message: typeof err.message === "string" ? err.message : "Pattern analysis failed.",
    };
  }
  if (error instanceof Error && error.message.startsWith("Invalid environment configuration")) {
    return { code: "CDSE_CONFIG", message: error.message };
  }
  return { code: "UPSTREAM_ERROR", message: "Imagery service request failed. Try again shortly." };
}

/** Replays a cached run as the full frame sequence the live path emits. */
function sendCached(result: PatternResult, send: SendFrame): void {
  send({ type: "stage", stage: "fields" });
  send({ type: "stage", stage: "ndvi" });
  result.months.forEach((label, index) => send({ type: "month", index, label }));
  send({ type: "stage", stage: "analyze" });
  send({ type: "result", ...result });
}

/**
 * POST /api/fields/pattern — monthly-NDVI cropping pattern per field.
 *
 * Body: { bbox: [west, south, east, north], year: 2024|2025,
 *         minConfidence?: 0..100, grouping?: boolean }.
 * Streams newline-delimited JSON:
 *   {"type":"stage","stage":"fields"|"ndvi"|"analyze"}   (progress, in order)
 *   {"type":"month","index":0..11,"label":"YYYY-MM"}     (one per month)
 *   {"type":"result", …PatternResult}                    (final)
 *   {"type":"error","code","message"}                    (mid-stream failure)
 * Guard order: origin → rate limit → enabled → role capability → schema →
 * area → cache → PU pre-flight → fields build → no-fields → mock source.
 * Errors before the stream is open answer as normal { status, code, message }
 * JSON.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "compare");
  if (guard) return guard;

  try {
    const env = getServerEnv();
    if (!env.FIELDS_ENABLED) {
      throw apiError(404, "FIELDS_DISABLED", "Field boundaries are not enabled on this deployment.");
    }

    // SSO-only capability (401 without a session, 403 FORBIDDEN_ROLE for guests).
    const locked = await requireCapability(request, "fields.pattern");
    if (locked) return locked;

    const body = await readJsonBody(request, (raw) => patternRequestSchema.parse(raw));
    const bbox = body.bbox;
    const selectedAreaKm2 = bboxAreaKm2(bbox);
    if (selectedAreaKm2 > env.FIELDS_MAX_KM2) {
      throw apiError(
        400,
        "AREA_TOO_LARGE",
        `Selected area is ${selectedAreaKm2.toFixed(1)} km²; the limit is ${env.FIELDS_MAX_KM2} km².`,
      );
    }

    const year = body.year as FieldsYear;
    const minConfidence = body.minConfidence ?? env.FIELDS_MIN_CONFIDENCE;
    const grouping = body.grouping ?? env.FIELDS_GROUPING;
    const cacheKey = patternCacheKey({
      bbox,
      year,
      minConfidence,
      grouping,
      maxCount: env.FIELDS_MAX_COUNT,
    });

    // Cached run answers from memory: no PU, no field build, no CDSE.
    const cached = patternCache.get(cacheKey);
    if (cached) {
      return ndjsonResponse(async (send) => {
        sendCached(cached, send);
      });
    }

    // Pure pre-flight — never billed, never fetched: 12 monthly renders.
    const grid = preparePatternGrid(bbox);
    const estimatedPu = estimatePatternPu(grid);
    if (env.PER_ANALYSIS_PU_LIMIT > 0 && estimatedPu > env.PER_ANALYSIS_PU_LIMIT) {
      throw apiError(
        413,
        "PU_LIMIT_EXCEEDED",
        `This selection needs about ${estimatedPu.toFixed(1)} PU across 12 monthly ` +
          `renders; the per-analysis limit is ${env.PER_ANALYSIS_PU_LIMIT} PU.`,
      );
    }

    const fieldsKey = fieldsCacheKey({ bbox, year });
    let entry = fieldsCache.get(fieldsKey);
    if (!entry) {
      try {
        entry = await buildFieldsRaw(
          {
            readRange: httpRangeReader(env.FTW_PMTILES_URL),
            readConfidence: (selection) => readConfidenceWindow(env.FTW_CONFIDENCE_COG_URL, selection),
          },
          { bbox, year },
        );
      } catch (error) {
        if (isContractError(error)) throw error;
        throw apiError(
          503,
          "FIELDS_UNAVAILABLE",
          "Field boundary data is temporarily unavailable. Try again shortly.",
        );
      }
      fieldsCache.set(fieldsKey, entry, FIELDS_CACHE_TTL_SECONDS);
    }

    const filtered = filterFields(entry, minConfidence, env.FIELDS_MAX_COUNT);
    if (filtered.count === 0) {
      throw apiError(
        400,
        "NO_FIELDS",
        "No fields match this selection at the current confidence threshold.",
      );
    }

    // Last gate before any CDSE work: the mock catalogue has no imagery.
    if (dataSource === "mock") {
      throw apiError(400, "CDSE_CONFIG", MOCK_PATTERN_MESSAGE);
    }

    const size = { width: grid.width, height: grid.height };
    const geometry = bboxPolygon(bbox).geometry;
    const fetchMonth = async (month: PatternMonth) => {
      const buffer = await fetchAnalysisRaster({
        geometry,
        evalscript: NDVI_MONTH_EVALSCRIPT,
        size,
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: { from: month.from, to: month.to },
              mosaickingOrder: "mostRecent",
            },
            processing: { upsampling: "BICUBIC", downsampling: "BILINEAR" },
          },
        ],
      });
      return parseNdviMonthRaster(buffer);
    };

    const resultKey = cacheKey;
    return ndjsonResponse(async (send) => {
      send({ type: "stage", stage: "fields" });
      const result = await runPattern(
        { bbox, year, minConfidence, grouping, grid, estimatedPu },
        { fields: filtered, fetchMonth, onEvent: send },
      );
      patternCache.set(resultKey, result, FIELDS_CACHE_TTL_SECONDS);
      send({ type: "result", ...result });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
