import { NextResponse } from "next/server";
import { z } from "zod";
import { authorize, forbiddenZoomResponse } from "@/lib/auth/guard";
import { errorResponse, rateLimitGuard } from "@/lib/server/api";
import { TILE_MAX_ZOOM, TILE_MIN_ZOOM } from "@/lib/cdse/tiles";
import {
  assertKeyMatches,
  resolveCompareParams,
} from "@/lib/server/compareRun";
import { detailTilePng, ensureDetail } from "@/lib/server/detailRun";
import { detailTileCache, detailTileKey } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 1×1 transparent PNG — MapLibre expects a tile, not an error, off-AOI. */
const EMPTY_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==",
  "base64",
);

const querySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/, "key must be a 64-char hex digest"),
  layer: z.enum(["class", "coverage", "magnitude", "gapfill"]).default("class"),
  index: z.enum(["ndvi", "mndwi", "ndbi", "combined"]).default("combined"),
  showUnchanged: z.enum(["0", "1"]).default("0"),
  /** Class-layer legend toggles: comma-separated class codes to hide. */
  hide: z.string().regex(/^\d+(,\d+)*$/, "hide must be a comma list of class codes").optional(),
  // Optional analysis parameters → stateless recompute on a cache miss
  // (same contract as /api/compare/events and overlay).
  areaId: z.string().optional(),
  level: z.enum(["district", "tehsil", "ilr"]).optional(),
  dateA: z.string().optional(),
  dateB: z.string().optional(),
  sensitivity: z.enum(["low", "medium", "high", "veryhigh", "auto"]).optional(),
  minPatchHa: z.coerce.number().optional(),
  speckle: z.enum(["gentle", "legacy"]).optional(),
  inputMode: z.enum(["single", "composite"]).optional(),
  compositeWindowDays: z.coerce.number().int().optional(),
  detail: z.enum(["quick", "detailed", "smart"]).optional(),
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

function tileResponse(buffer: Buffer, cacheStatus: string, immutable: boolean): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
      "X-Imagery-Cache": cacheStatus,
    },
  });
}

/**
 * GET /api/compare/tiles/[z]/[x]/[y]?key=…&<analysis params>[&layer=…]
 *                                                   [&index=…][&showUnchanged=1]
 *
 * Native-resolution tiles of a detailed/smart comparison, assembled from the
 * cached blocks (512 px per tile, nearest-neighbour on the AOI grid). Skipped
 * smart blocks render as analysed-unchanged. Outside the AOI: transparent
 * empty tile. Parameters must re-derive the analysis key — a cold cache
 * recomputes the blocks statelessly (in-flight deduped, disk-persisted).
 */
export async function GET(
  request: Request,
  { params }: { params: { z: string; x: string; y: string } },
): Promise<NextResponse> {
  const guard = rateLimitGuard(request, "tiles");
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(request.url);
    const z = Number.parseInt(params.z, 10);
    const x = Number.parseInt(params.x, 10);
    const y = Number.parseInt(params.y.replace(/\.png$/i, ""), 10);
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
      return NextResponse.json(
        { code: "INVALID_TILE", message: "Tile coordinates must be integers." },
        { status: 400 },
      );
    }
    // Outside the useful zoom band → empty tile (no recompute, no quota).
    if (z < TILE_MIN_ZOOM || z > TILE_MAX_ZOOM) {
      return emptyTileResponse({ "X-Tile-Skip": "zoom-out-of-range" });
    }
    // Role zoom cap (guest z≤12, SSO z≤14) — same contract as imagery tiles.
    if (z > auth.limits.tileZoomMax) return forbiddenZoomResponse(z);
    const maxIndex = 2 ** z;
    if (x < 0 || y < 0 || x >= maxIndex || y >= maxIndex) {
      return NextResponse.json(
        { code: "INVALID_TILE", message: `x/y out of range for zoom ${z}.` },
        { status: 400 },
      );
    }

    const query = querySchema.parse({
      key: url.searchParams.get("key"),
      layer: url.searchParams.get("layer") ?? undefined,
      index: url.searchParams.get("index") ?? undefined,
      showUnchanged: url.searchParams.get("showUnchanged") ?? undefined,
      hide: url.searchParams.get("hide") ?? undefined,
      areaId: url.searchParams.get("areaId") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      dateA: url.searchParams.get("dateA") ?? undefined,
      dateB: url.searchParams.get("dateB") ?? undefined,
      sensitivity: url.searchParams.get("sensitivity") ?? undefined,
      minPatchHa: url.searchParams.get("minPatchHa") ?? undefined,
      speckle: url.searchParams.get("speckle") ?? undefined,
      inputMode: url.searchParams.get("inputMode") ?? undefined,
      compositeWindowDays: url.searchParams.get("compositeWindowDays") ?? undefined,
      detail: url.searchParams.get("detail") ?? undefined,
    });

    const resolved = resolveCompareParams(query, { role: auth.role });
    assertKeyMatches(query.key, resolved.key);
    if (resolved.detail === "quick") {
      return NextResponse.json(
        {
          code: "QUICK_NO_TILES",
          message: "This comparison has no detailed tiles — run a detailed or smart comparison.",
        },
        { status: 400 },
      );
    }

    const showUnchanged = query.showUnchanged === "1";
    const variant =
      query.layer === "magnitude"
        ? query.index
        : query.hide
          ? `hide-${query.hide}`
          : "default";
    const tileKey = detailTileKey(
      query.key,
      query.layer,
      variant,
      z,
      x,
      y,
      showUnchanged,
    );
    const cached = detailTileCache.get(tileKey);
    if (cached) {
      const today = new Date().toISOString().slice(0, 10);
      return tileResponse(cached, "hit", resolved.dateB < today);
    }

    const { entry } = await ensureDetail(resolved);
    if (!entry.detail) {
      return NextResponse.json(
        {
          code: "QUICK_NO_TILES",
          message: "This comparison has no detailed tiles — run a detailed or smart comparison.",
        },
        { status: 400 },
      );
    }
    const png = await detailTilePng(resolved, entry, {
      layer: query.layer,
      index: query.index,
      showUnchanged,
      hideCodes: query.hide
        ? query.hide.split(",").map((code) => Number(code)).filter((code) => code > 0 && code <= 6)
        : undefined,
      z,
      x,
      y,
    });
    if (!png) return emptyTileResponse({ "X-Tile-Skip": "outside-aoi" });
    detailTileCache.set(tileKey, png, 3600);
    const today = new Date().toISOString().slice(0, 10);
    return tileResponse(png, "miss", resolved.dateB < today);
  } catch (error) {
    return errorResponse(error);
  }
}
