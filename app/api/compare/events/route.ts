import { NextResponse } from "next/server";
import { z } from "zod";
import { EVENTS_PAGE_LIMIT_DEFAULT, EVENTS_PAGE_LIMIT_MAX, pageEvents } from "@/lib/analysis/events";
import { compareResultCache } from "@/lib/cache";
import { apiError, errorResponse, rateLimitGuard } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 15;

const querySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/, "key must be a 64-char hex digest"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(EVENTS_PAGE_LIMIT_MAX)
    .default(EVENTS_PAGE_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
  /** Exact change-class filter (CLASS codes from lib/analysis/config). */
  classCode: z.coerce.number().int().optional(),
  /** Minimum confidence tier (engine v2; v1 events carry no tier and are excluded). */
  confidence: z.enum(["low", "medium", "high"]).optional(),
});

/**
 * GET /api/compare/events?key=…&limit=…&offset=…&classCode=…&confidence=…
 *
 * The full-coverage change events of a completed analysis (Phase 6, #13/#16):
 * one feature per kept change patch — largest first — with a stable id,
 * class, area, centroid and (v2) majority confidence tier. Paging is applied
 * after the optional filters; `total` is the filtered count.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  try {
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));

    const entry = compareResultCache.get(query.key);
    if (!entry) {
      throw apiError(404, "EVENTS_NOT_FOUND", "This comparison result has expired. Run the analysis again.");
    }

    const page = pageEvents(entry.events.features, {
      limit: query.limit,
      offset: query.offset,
      classCode: query.classCode,
      confidence: query.confidence,
    });

    const today = new Date().toISOString().slice(0, 10);
    const { dateA, dateB } = entry.stats.metadata;
    const lastDate = dateA > dateB ? dateA : dateB;
    const cacheControl =
      lastDate < today ? "public, max-age=31536000, immutable" : "public, max-age=3600";

    return NextResponse.json(
      { key: query.key, total: page.total, limit: page.limit, offset: page.offset, events: page.items },
      {
        status: 200,
        headers: { "Cache-Control": cacheControl },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
