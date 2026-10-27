import { NextResponse } from "next/server";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { encodeClassGeoTiff } from "@/lib/analysis/tiff";
import { compareResultCache } from "@/lib/cache";
import { apiError, binaryStreamResponse, errorResponse, rateLimitGuard } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 30;

const querySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/, "key must be a 64-char hex digest"),
  format: z.enum(["png", "geotiff"]).default("png"),
});

/**
 * GET /api/compare/overlay?key=…&format=png|geotiff
 *
 * The classified change map of a completed analysis:
 *  - png     → RGBA overlay (change classes coloured, no-change transparent,
 *              masked hatched grey) for the map image source;
 *  - geotiff → uint8 GeoTIFF (nodata 255 outside the polygon) for GIS export.
 * Past-date pairs are immutable → long-lived cache headers (same rule as tiles).
 */
export async function GET(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  try {
    const url = new URL(request.url);
    const query = querySchema.parse({
      key: url.searchParams.get("key"),
      format: url.searchParams.get("format") ?? "png",
    });

    const entry = compareResultCache.get(query.key);
    if (!entry) {
      throw apiError(404, "OVERLAY_NOT_FOUND", "This comparison result has expired. Run the analysis again.");
    }

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
