import { NextResponse } from "next/server";
import { z } from "zod";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import { getServerEnv } from "@/lib/env";
import { requireCapability } from "@/lib/auth/guard";
import { bboxAreaKm2 } from "@/lib/cdse/geometry";
import { fieldsCache, fieldsCacheKey, FIELDS_CACHE_TTL_SECONDS } from "@/lib/cache";
import { readConfidenceWindow } from "@/lib/fields/confidence";
import {
  buildFieldsRaw,
  filterFields,
  httpRangeReader,
  type FieldsYear,
} from "@/lib/fields/query";

export const runtime = "nodejs";
export const maxDuration = 30;

const fieldsRequestSchema = z.object({
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
});

/**
 * POST /api/fields — Field boundaries for a bbox + year.
 *
 * Body: { bbox: [west, south, east, north], year: 2024|2025,
 *         minConfidence?: 0..100 } (defaults to FIELDS_MIN_CONFIDENCE).
 * Response: { bbox, year, minConfidence, selectedAreaKm2, confidenceAvailable,
 *             count, truncated, excluded: { confidence, noConfidence },
 *             totalAreaM2, fields: FeatureCollection }.
 * Errors: 404 FIELDS_DISABLED, 400 AREA_TOO_LARGE / INVALID_REQUEST,
 *         503 FIELDS_UNAVAILABLE (range/decode failure — no partial answers).
 * Server-side only: PMTiles + COG reads never reach the browser (CSP and
 * dependency budgets stay untouched).
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "api");
  if (guard) return guard;

  try {
    const env = getServerEnv();
    if (!env.FIELDS_ENABLED) {
      throw apiError(404, "FIELDS_DISABLED", "Field boundaries are not enabled on this deployment.");
    }

    // SSO-only capability (401 without a session, 403 FORBIDDEN_ROLE for guests).
    const locked = await requireCapability(request, "fields.pattern");
    if (locked) return locked;

    const body = await readJsonBody(request, (raw) => fieldsRequestSchema.parse(raw));
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
    const cacheKey = fieldsCacheKey({ bbox, year });

    let entry = fieldsCache.get(cacheKey);
    if (!entry) {
      const pmtilesUrl = env.FTW_PMTILES_URL;
      const confidenceUrl = env.FTW_CONFIDENCE_COG_URL;
      entry = await buildFieldsRaw(
        {
          readRange: httpRangeReader(pmtilesUrl),
          readConfidence: (selection) => readConfidenceWindow(confidenceUrl, selection),
        },
        { bbox, year },
      );
      fieldsCache.set(cacheKey, entry, FIELDS_CACHE_TTL_SECONDS);
    }

    const filtered = filterFields(entry, minConfidence, env.FIELDS_MAX_COUNT);
    return NextResponse.json(
      {
        bbox,
        year,
        minConfidence,
        selectedAreaKm2,
        confidenceAvailable: entry.confidenceAvailable,
        count: filtered.count,
        truncated: filtered.truncated,
        excluded: filtered.excluded,
        totalAreaM2: filtered.totalAreaM2,
        fields: filtered.fields,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
