import { NextResponse } from "next/server";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { encodeClassGeoTiff } from "@/lib/analysis/tiff";
import {
  classToRgba,
  coverageToRgba,
  encodePng,
  gapFillToRgba,
  magnitudeToRgba,
} from "@/lib/analysis/png";
import { authorize, requireCapability } from "@/lib/auth/guard";
import { binaryStreamResponse, errorResponse, rateLimitGuard } from "@/lib/server/api";
import { entryForKey } from "@/lib/server/compareRun";
import { overlayLayerCache } from "@/lib/cache";

export const runtime = "nodejs";
/** 60 s — a cold cache now recomputes the analysis (same cost as analyze). */
export const maxDuration = 60;

/** Derived-layer cache TTL (seconds) — keyed by analysis key + variant. */
const LAYER_TTL_SECONDS = 3600;

/** Inflated plane bytes → Int8Array view (no copy — quantised Δ values). */
function int8View(bytes: Buffer): Int8Array {
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const querySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/, "key must be a 64-char hex digest"),
  format: z.enum(["png", "geotiff"]).default("png"),
  /** "1" when the PNG is fetched as a file download (export button) rather
   *  than as the map's image source — exports need the exports capability. */
  download: z.enum(["0", "1"]).default("0"),
  /** Phase 1 display layers: class (default) = the classified change map;
   *  coverage = per-pixel reason (analysed / A missing / B missing / cloud /
   *  unknown); magnitude = Δ-index magnitude planes; gapfill = pixels only
   *  analysed thanks to the ±window rescue render. Display-only — exports
   *  (format/download) always answer the class layer. */
  layer: z.enum(["class", "coverage", "magnitude", "gapfill"]).default("class"),
  /** Magnitude plane (layer=magnitude): signed Δ per index, or combined. */
  index: z.enum(["ndvi", "mndwi", "ndbi", "combined"]).default("combined"),
  /** "1" → no-change pixels get the subtle "analysed" tint instead of staying
   *  transparent, so masked vs unchanged vs outside is readable at a glance. */
  showUnchanged: z.enum(["0", "1"]).default("0"),
  // Optional analysis parameters → stateless recompute on a cache miss
  // (same contract as /api/compare/events).
  areaId: z.string().optional(),
  level: z.enum(["district", "tehsil", "ilr"]).optional(),
  dateA: z.string().optional(),
  dateB: z.string().optional(),
  sensitivity: z.enum(["low", "medium", "high", "veryhigh", "auto"]).optional(),
  minPatchHa: z.coerce.number().optional(),
  speckle: z.enum(["gentle", "legacy"]).optional(),
  detail: z.enum(["quick", "detailed", "smart"]).optional(),
  // Phase-thresholds: JSON-encoded override map (paramsToQuery form) —
  // decoded here so the canonical schema validates + clamps the values.
  thresholds: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return undefined;
      }
    }),
  inputMode: z.enum(["single", "composite"]).optional(),
  compositeWindowDays: z.coerce.number().int().optional(),
});

/**
 * GET /api/compare/overlay?key=…&format=png|geotiff[&layer=…][&showUnchanged=1]
 *
 * The classified change map of a completed analysis:
 *  - png     → RGBA overlay (change classes coloured, no-change transparent,
 *              masked hatched grey) for the map image source;
 *  - geotiff → uint8 GeoTIFF (nodata 255 outside the polygon) for GIS export.
 * Past-date pairs are immutable → long-lived cache headers (same rule as tiles).
 * With analysis parameters a cold cache recomputes instead of 404-ing — the
 * map overlay must come back exactly like the markers/list the client holds.
 *
 * Phase 1 layers (layer=coverage|magnitude|gapfill) are derived PNGs built
 * from the same artifact and cached the same way — display only, never
 * exported.
 *
 * Exports (GeoTIFF, or PNG with download=1) need the exports.change-map
 * capability; the plain PNG image source only needs a session.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  const url = new URL(request.url);
  const isExport =
    url.searchParams.get("format") === "geotiff" || url.searchParams.get("download") === "1";
  if (isExport) {
    const denied = await requireCapability(request, "exports.change-map");
    if (denied) return denied;
  }
  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const query = querySchema.parse({
      key: url.searchParams.get("key"),
      format: url.searchParams.get("format") ?? "png",
      download: url.searchParams.get("download") ?? undefined,
      layer: url.searchParams.get("layer") ?? undefined,
      index: url.searchParams.get("index") ?? undefined,
      showUnchanged: url.searchParams.get("showUnchanged") ?? undefined,
      areaId: url.searchParams.get("areaId") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      dateA: url.searchParams.get("dateA") ?? undefined,
      dateB: url.searchParams.get("dateB") ?? undefined,
      sensitivity: url.searchParams.get("sensitivity") ?? undefined,
      minPatchHa: url.searchParams.get("minPatchHa") ?? undefined,
      inputMode: url.searchParams.get("inputMode") ?? undefined,
      compositeWindowDays: url.searchParams.get("compositeWindowDays") ?? undefined,
    });
    // Exports are defined on the classified raster only.
    if (isExport && query.layer !== "class") {
      return errorResponse(
        Object.assign(new Error("Exports are only available for the classified layer."), {
          status: 400,
          code: "LAYER_NOT_EXPORTABLE",
        }),
      );
    }

    const entry = await entryForKey(query.key, query, { role: auth.role });

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

    // Classified layer without the unchanged tint → the artifact's own PNG.
    if (query.layer === "class" && query.showUnchanged === "0") {
      return new NextResponse(new Uint8Array(entry.overlayPng), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": cacheControl,
          "X-Imagery-Cache": "compare",
        },
      });
    }

    // Derived variants: encode once, cache per key × variant.
    const variant =
      query.layer === "class"
        ? "class-uc"
        : query.layer === "magnitude"
          ? `magnitude-${query.index}`
          : query.layer;
    const cacheKey = `${query.key}|${variant}`;
    let png = overlayLayerCache.get(cacheKey);
    if (!png) {
      const classGrid = inflateSync(entry.classGz);
      const rgba =
        query.layer === "class"
          ? classToRgba(classGrid, entry.width, { showUnchanged: true })
          : query.layer === "coverage"
            ? coverageToRgba(inflateSync(entry.coverageGz))
            : query.layer === "gapfill"
              ? gapFillToRgba(inflateSync(entry.sourceGz), classGrid, entry.width)
              : magnitudeToRgba(
                int8View(inflateSync(entry.magnitudeGz[query.index])),
                classGrid,
                entry.width,
                query.index === "combined" ? "combined" : "signed",
              );
      png = encodePng(rgba, entry.width, entry.height);
      overlayLayerCache.set(cacheKey, png, LAYER_TTL_SECONDS);
    }

    return new NextResponse(new Uint8Array(png), {
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
