import { NextResponse } from "next/server";
import { z } from "zod";
import { area as turfArea, booleanIntersects, feature } from "@turf/turf";
import { fetchWmtsTile, hasWmtsInstance } from "@/lib/cdse/wmts";
import { renderTileImage } from "@/lib/cdse/process";
import {
  MAX_TILES_PER_AREA,
  TILE_MAX_ZOOM,
  TILE_MIN_ZOOM,
  polygonToMercator,
  tileToBBox3857,
  tileToBBox4326,
  tilesSpannedByBBox,
} from "@/lib/cdse/tiles";
import { diskCacheGet, diskCacheSet, imageryCache, tileCache, tileCacheKey } from "@/lib/cache";
import { getServerEnv } from "@/lib/env";
import { authorize, forbiddenZoomResponse } from "@/lib/auth/guard";
import { bumpGlobalCounter } from "@/lib/auth/quota";
import { errorResponse, rateLimitGuard } from "@/lib/server/api";
import { resolveArea } from "@/lib/server/areas";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/tiles/{z}/{x}/{y}.png?date=YYYY-MM-DD&composite=...&areaId=...&level=...
 *
 * Native-resolution (Copernicus Browser-style) XYZ tiles: one 512px Process
 * API render per tile, registered to the tile bbox (EPSG:3857) and clipped to
 * the area polygon (transparent outside). With no query params the route keeps
 * the legacy WMTS proxy behaviour (requires CDSE_WMTS_INSTANCE_ID).
 */

/**
 * 1×1 fully transparent PNG (rgba(0,0,0,0), color type 6) — returned instead
 * of calling Process API. Verified by inflating the IDAT: `00 00 00 00 00`.
 * (The commonly copy-pasted "transparent pixel" base64 decodes to
 * rgba(0,0,255,127) — a semi-transparent blue that washes every skipped tile.)
 */
const EMPTY_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==",
  "base64",
);

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  composite: z.enum(["true-color", "false-color", "ndvi"]).default("true-color"),
  areaId: z.string().trim().min(1),
  level: z.enum(["district", "tehsil", "ilr"]),
});

function emptyTileResponse(extraHeaders?: Record<string, string>): NextResponse {
  return new NextResponse(new Uint8Array(EMPTY_TILE), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function tileResponse(buffer: Buffer, cacheStatus: string, date: string): NextResponse {
  const today = new Date().toISOString().slice(0, 10);
  // Past dates are immutable — cache aggressively (browsers + CDNs).
  const maxAge = date < today ? 31_536_000 : 3_600;
  bumpGlobalCounter("render");
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control":
        date < today ? `public, max-age=${maxAge}, immutable` : `public, max-age=${maxAge}`,
      "X-Imagery-Cache": cacheStatus,
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: { z: string; x: string; y: string } },
): Promise<NextResponse> {
  const guard = rateLimitGuard(request, "tiles");
  if (guard) return guard;

  // Role context first: every tile request needs a session (or the ambient
  // guest when the auth gate is off), and the role's zoom cap applies below.
  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(request.url);

    // Legacy WMTS proxy mode (no area/date params): unchanged behaviour.
    if (!url.searchParams.has("date") && !url.searchParams.has("areaId")) {
      if (!hasWmtsInstance()) {
        return NextResponse.json(
          {
            code: "WMTS_DISABLED",
            message:
              "Tile mode requires ?date=&areaId=&level= (native tiles) or CDSE_WMTS_INSTANCE_ID (WMTS proxy).",
          },
          { status: 404 },
        );
      }
      const zLegacy = Number.parseInt(params.z, 10);
      const xLegacy = Number.parseInt(params.x, 10);
      const yLegacy = Number.parseInt(params.y.replace(/\.png$/i, ""), 10);
      if (
        !Number.isInteger(zLegacy) ||
        !Number.isInteger(xLegacy) ||
        !Number.isInteger(yLegacy) ||
        zLegacy < 0 ||
        zLegacy > 24
      ) {
        return NextResponse.json(
          { code: "INVALID_TILE", message: "Tile coordinates must be integers (z 0-24)." },
          { status: 400 },
        );
      }
      if (zLegacy > auth.limits.tileZoomMax) return forbiddenZoomResponse(zLegacy);
      const key = `wmtstile:${zLegacy}:${xLegacy}:${yLegacy}`;
      const cached = imageryCache.get(key);
      if (cached) return tileResponse(cached, "hit", "1970-01-01");
      const buffer = await fetchWmtsTile(zLegacy, xLegacy, yLegacy);
      imageryCache.set(key, buffer, 86_400);
      return tileResponse(buffer, "miss", "1970-01-01");
    }

    // ------------------------------------------------ native tile mode
    const z = Number.parseInt(params.z, 10);
    const x = Number.parseInt(params.x, 10);
    const y = Number.parseInt(params.y.replace(/\.png$/i, ""), 10);
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
      return NextResponse.json(
        { code: "INVALID_TILE", message: "Tile coordinates must be integers." },
        { status: 400 },
      );
    }

    // Zoom guards: outside the useful band just yield an empty tile
    // (MapLibre-friendly; no Process API call, no quota spent).
    if (z < TILE_MIN_ZOOM || z > TILE_MAX_ZOOM) {
      return emptyTileResponse({ "X-Tile-Skip": "zoom-out-of-range" });
    }
    // Role zoom cap (guest z≤12, SSO z≤14): refused like a missing
    // capability so the client can set its source maxzoom from limits.
    if (z > auth.limits.tileZoomMax) return forbiddenZoomResponse(z);
    const maxIndex = 2 ** z;
    if (x < 0 || y < 0 || x >= maxIndex || y >= maxIndex) {
      return NextResponse.json(
        { code: "INVALID_TILE", message: `x/y out of range for zoom ${z}.` },
        { status: 400 },
      );
    }

    const query = querySchema.parse({
      date: url.searchParams.get("date"),
      composite: url.searchParams.get("composite") ?? "true-color",
      areaId: url.searchParams.get("areaId"),
      level: url.searchParams.get("level") ?? "district",
    });

    const area = resolveArea(query.level, query.areaId);
    if (!area) {
      return NextResponse.json(
        { code: "AREA_NOT_FOUND", message: "Unknown area for this tile request." },
        { status: 404 },
      );
    }

    // Tile vs area intersection: cheap bbox test first, then precise polygon.
    const tileBBox4326 = tileToBBox4326(z, x, y);
    const [w, s, e, n] = area.bbox;
    if (tileBBox4326[2] < w || tileBBox4326[0] > e || tileBBox4326[3] < s || tileBBox4326[1] > n) {
      return emptyTileResponse({ "X-Tile-Skip": "outside-area" });
    }
    const tilePoly = feature({
      type: "Polygon",
      coordinates: [
        [
          [tileBBox4326[0], tileBBox4326[1]],
          [tileBBox4326[2], tileBBox4326[1]],
          [tileBBox4326[2], tileBBox4326[3]],
          [tileBBox4326[0], tileBBox4326[3]],
          [tileBBox4326[0], tileBBox4326[1]],
        ],
      ],
    });
    try {
      if (!booleanIntersects(feature(area.geometry), tilePoly)) {
        return emptyTileResponse({ "X-Tile-Skip": "outside-area" });
      }
    } catch {
      // Invalid area geometry — fall through and let the render decide.
    }

    // Quota guard: worst-case tiles that actually intersect the polygon at
    // this zoom. A bbox-span count over-counts districts whose bbox includes
    // large empty corners (Jaipur at z15 ≈ 27k bbox tiles vs ~3.5k real ones)
    // and wrongly disabled native z15 renders. Estimate from polygon area with
    // a 1.5× shape factor; fall back to the bbox span if the area fails.
    let worstTiles: number;
    try {
      const polyKm2 = turfArea(feature(area.geometry)) / 1e6;
      const latMid = (area.bbox[1] + area.bbox[3]) / 2;
      // One XYZ tile covers the standard 2^z grid: 40075 km · cos(lat) / 2^z.
      const tileKm = (40075.016686 * Math.cos((latMid * Math.PI) / 180)) / 2 ** z;
      worstTiles = Math.ceil((polyKm2 / Math.max(tileKm * tileKm, 1e-6)) * 1.5) + 16;
    } catch {
      worstTiles = tilesSpannedByBBox(area.bbox, z);
    }
    if (worstTiles > MAX_TILES_PER_AREA) {
      return emptyTileResponse({
        "X-Tile-Skip": "too-many-tiles",
        "X-Tile-Skip-Reason": `Area needs ~${worstTiles} tiles at z${z} (max ${MAX_TILES_PER_AREA}).`,
      });
    }

    const key = tileCacheKey({
      areaId: query.areaId,
      level: query.level,
      date: query.date,
      composite: query.composite,
      z,
      x,
      y,
    });

    const env = getServerEnv();
    const cached = tileCache.get(key) ?? diskCacheGet(key, env.TILE_CACHE_DIR);
    if (cached) {
      tileCache.set(key, cached, env.IMAGERY_CACHE_TTL_SECONDS);
      return tileResponse(cached, "hit", query.date);
    }

    const buffer = await renderTileImage({
      bbox3857: tileToBBox3857(z, x, y),
      geometryMercator: polygonToMercator(area.geometry),
      date: query.date,
      composite: query.composite,
      size: 512,
    });
    tileCache.set(key, buffer, env.IMAGERY_CACHE_TTL_SECONDS);
    diskCacheSet(key, buffer, env.TILE_CACHE_DIR);

    return tileResponse(buffer, "miss", query.date);
  } catch (error) {
    return errorResponse(error);
  }
}
