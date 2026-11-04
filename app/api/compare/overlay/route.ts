import { NextResponse } from "next/server";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { encodeClassGeoTiff } from "@/lib/analysis/tiff";
import { binaryStreamResponse, errorResponse, rateLimitGuard } from "@/lib/server/api";
import { entryForKey } from "@/lib/server/compareRun";

export const runtime = "nodejs";
/** 60 s — a cold cache now recomputes the analysis (same cost as analyze). */
export const maxDuration = 60;

const querySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/, "key must be a 64-char hex digest"),
  format: z.enum(["png", "geotiff"]).default("png"),
  // Optional analysis parameters → stateless recompute on a cache miss
  // (same contract as /api/compare/events).
  areaId: z.string().optional(),
  level: z.enum(["district", "tehsil", "ilr"]).optional(),
  dateA: z.string().optional(),
  dateB: z.string().optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
  minPatchHa: z.coerce.number().optional(),
  inputMode: z.enum(["single", "composite"]).optional(),
  compositeWindowDays: z.coerce.number().int().optional(),
});

/**
 * GET /api/compare/overlay?key=…&format=png|geotiff
 *
 * The classified change map of a completed analysis:
 *  - png     → RGBA overlay (change classes coloured, no-change transparent,
 *              masked hatched grey) for the map image source;
 *  - geotiff → uint8 GeoTIFF (nodata 255 outside the polygon) for GIS export.
 * Past-date pairs are immutable → long-lived cache headers (same rule as tiles).
 * With analysis parameters a cold cache recomputes instead of 404-ing — the
 * map overlay must come back exactly like the markers/list the client holds.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  try {
    const url = new URL(request.url);
    const query = querySchema.parse({
      key: url.searchParams.get("key"),
      format: url.searchParams.get("format") ?? "png",
      areaId: url.searchParams.get("areaId") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      dateA: url.searchParams.get("dateA") ?? undefined,
      dateB: url.searchParams.get("dateB") ?? undefined,
      sensitivity: url.searchParams.get("sensitivity") ?? undefined,
      minPatchHa: url.searchParams.get("minPatchHa") ?? undefined,
      inputMode: url.searchParams.get("inputMode") ?? undefined,
      compositeWindowDays: url.searchParams.get("compositeWindowDays") ?? undefined,
    });

    const entry = await entryForKey(query.key, query);

    const today = new Date().toISOString().slice(0, 10);
    const { dateA, dateB } = entry.stats.metadata;
    const lastDate = dateA > dateB ? dateA : dateB;
    const cacheControl =
      lastDate < today ? "public, max-age=31536000, immutable" : "public, max-age=3600";

    if (query.format === "geotiff") {
      const classGrid = inflateSync(entry.classGz);
      const tiff = encodeClassGeoTiff({
        classGrid,
        width: entry.width,
        height: entry.height,
        bbox: entry.bbox,
      });
      return binaryStreamResponse(tiff, {
        "Content-Type": "image/tiff",
        "Cache-Control": cacheControl,
        "Content-Disposition": `inline; filename="change_${dateA}_${dateB}.tif"`,
      });
    }

    return new NextResponse(new Uint8Array(entry.overlayPng), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": cacheControl,
        "X-Imagery-Cache": "compare",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
