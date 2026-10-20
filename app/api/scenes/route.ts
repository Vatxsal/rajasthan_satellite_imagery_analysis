import { NextResponse } from "next/server";
import { z } from "zod";
import { area, featureCollection, intersect, union } from "@turf/turf";
import { searchCatalog, type CatalogHit } from "@/lib/cdse/catalog";
import { bboxAreaKm2, bboxFromGeometry, type ClipGeometry } from "@/lib/cdse/geometry";
import { districtsFc, ilrsFc, tehsilsFc } from "@/lib/data/boundaries";
import type { Scene, SceneProduct } from "@/lib/data";
import { getServerEnv } from "@/lib/env";
import { errorResponse, rateLimitGuard, readJsonBody, sameOriginGuard } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_RESULTS = 18;
/** Catalogue fetch cap; tiles are grouped by date afterwards. */
const CATALOG_LIMIT = 100;

const searchBodySchema = z.object({
  districtId: z.string().trim().min(1).nullish(),
  tehsilId: z.string().trim().min(1).nullish(),
  ilrId: z.string().trim().min(1).nullish(),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be YYYY-MM-DD"),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be YYYY-MM-DD"),
  maxCloudCover: z.coerce.number().min(0).max(100),
  composite: z.enum(["true-color", "false-color", "ndvi"]),
});

function findGeometry(params: {
  districtId?: string | null;
  tehsilId?: string | null;
  ilrId?: string | null;
}): { geometry: ClipGeometry; districtId: string } | null {
  if (params.ilrId) {
    const feature = ilrsFc.features.find((f) => f.properties?.id === params.ilrId);
    if (feature) {
      return {
        geometry: feature.geometry as ClipGeometry,
        districtId: String(feature.properties?.districtId ?? ""),
      };
    }
  }
  if (params.tehsilId) {
    const feature = tehsilsFc.features.find((f) => f.properties?.id === params.tehsilId);
    if (feature) {
      return {
        geometry: feature.geometry as ClipGeometry,
        districtId: String(feature.properties?.districtId ?? ""),
      };
    }
  }
  if (params.districtId) {
    const feature = districtsFc.features.find((f) => f.properties?.id === params.districtId);
    if (feature) {
      return { geometry: feature.geometry as ClipGeometry, districtId: String(feature.properties?.id ?? "") };
    }
  }
  return null;
}

function friendlySatellite(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes("sentinel-2a")) return "Sentinel-2A MSI";
  if (p.includes("sentinel-2b")) return "Sentinel-2B MSI";
  if (p.includes("sentinel-2c")) return "Sentinel-2C MSI";
  if (p.includes("sentinel-2")) return "Sentinel-2 MSI";
  if (p.includes("landsat-9")) return "Landsat-9 OLI";
  if (p.includes("landsat-8")) return "Landsat-8 OLI";
  return platform || "Sentinel-2 MSI";
}

function platformCode(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes("sentinel-2a")) return "S2A";
  if (p.includes("sentinel-2b")) return "S2B";
  if (p.includes("sentinel-2c")) return "S2C";
  return "S2";
}

/** "S2C_MSIL2A_…_T43RUM_…" → "T43RUM"; "" when the product isn't a tailed S2 id. */
function mgrsTile(productId: string): string {
  const match = /_T\d{2}[A-Z]{3}_/.exec(productId);
  return match ? match[0].slice(1, -1) : "";
}

/**
 * Per-tile catalogue products for a daily mosaic — the ids Copernicus Browser
 * / Data Space need to fetch the actual .SAFE ZIPs. Sorted best-first so the
 * dialog leads with the clearest tile.
 */
function toProducts(tiles: CatalogHit[]): SceneProduct[] {
  return tiles
    .map((tile) => ({
      id: tile.id,
      tile: mgrsTile(tile.id),
      datetime: tile.datetime,
      cloudCover: tile.cloudCover,
      satellite: friendlySatellite(tile.satellite),
      bbox: tile.bbox,
    }))
    .sort((a, b) => a.cloudCover - b.cloudCover || a.tile.localeCompare(b.tile));
}

function toTurfPolygon(geometry: GeoJSON.Polygon) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry,
  };
}

/**
 * Percent of the selected area covered by the day's tile footprints.
 * Uses union → intersect → area (spherical, m²). Returns 0-100.
 */
function coveragePercent(
  tiles: GeoJSON.Polygon[],
  selection: GeoJSON.Polygon,
): number {
  try {
    const selectionFeature = toTurfPolygon(selection);
    const selectionArea = area(selectionFeature);
    if (selectionArea <= 0) return 0;

    let covered: ReturnType<typeof toTurfPolygon> | null = null;
    for (const tile of tiles) {
      const tileFeature = toTurfPolygon(tile);
      if (!covered) {
        covered = tileFeature;
        continue;
      }
      const merged = union(featureCollection([covered, tileFeature]));
      if (merged) covered = merged as typeof covered;
    }
    if (!covered) return 0;

    const overlap = intersect(featureCollection([covered, selectionFeature]));
    if (!overlap) return 0;
    return Math.min(100, Math.round((area(overlap) / selectionArea) * 100));
  } catch {
    return 0;
  }
}

/** Union bbox of a day's tile footprints. */
function dayBBox(tiles: CatalogHit[]): Scene["bbox"] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const tile of tiles) {
    west = Math.min(west, tile.bbox[0]);
    south = Math.min(south, tile.bbox[1]);
    east = Math.max(east, tile.bbox[2]);
    north = Math.max(north, tile.bbox[3]);
  }
  return Number.isFinite(west) ? [west, south, east, north] : tiles[0]!.bbox;
}

export async function POST(request: Request): Promise<NextResponse> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  try {
    const env = getServerEnv();
    const body = await readJsonBody(request, (raw) => searchBodySchema.parse(raw));

    const resolved = findGeometry(body);
    if (!resolved) {
      return NextResponse.json(
        {
          code: "NO_AREA_SELECTED",
          message: "Select a district, tehsil, or ILR area before searching.",
        },
        { status: 400 },
      );
    }

    const bbox = bboxFromGeometry(resolved.geometry);
    if (!bbox) {
      return NextResponse.json(
        { code: "INVALID_GEOMETRY", message: "Selected area has no coordinates." },
        { status: 400 },
      );
    }

    const areaKm2 = bboxAreaKm2(bbox);
    if (areaKm2 > env.MAX_AOI_KM2) {
      return NextResponse.json(
        {
          code: "AOI_TOO_LARGE",
          message: `Area too large for live imagery (~${Math.round(areaKm2).toLocaleString()} km²). Pick a smaller district, tehsil, or ILR area (limit ${env.MAX_AOI_KM2.toLocaleString()} km²).`,
        },
        { status: 400 },
      );
    }

    const hits = await searchCatalog({
      bbox,
      from: body.fromDate,
      to: body.toDate,
      maxCloud: body.maxCloudCover,
      limit: CATALOG_LIMIT,
    });

    // Group tiles by acquisition date → one scene per day (daily mosaic).
    const byDate = new Map<string, CatalogHit[]>();
    for (const hit of hits) {
      const list = byDate.get(hit.date);
      if (list) list.push(hit);
      else byDate.set(hit.date, [hit]);
    }

    const thumbnailBase = new URL("/api/imagery", request.url);
    const scenes: Scene[] = [];

    for (const [date, tiles] of Array.from(byDate.entries())) {
      const minCloud = Math.min(...tiles.map((t: CatalogHit) => t.cloudCover));
      const tilePolys = tiles
        .map((t: CatalogHit) => t.geometry)
        .filter((g): g is GeoJSON.Polygon => g !== null);
      const coverage = tilePolys.length
        ? coveragePercent(tilePolys, resolved.geometry as GeoJSON.Polygon)
        : 0;
      const best = tiles.reduce((a: CatalogHit, b: CatalogHit) =>
        a.cloudCover <= b.cloudCover ? a : b,
      );

      // Union of the day's tile footprints (hover outline / footprint layer).
      let footprint: GeoJSON.Polygon | GeoJSON.MultiPolygon | undefined;
      if (tilePolys.length === 1) {
        footprint = tilePolys[0];
      } else if (tilePolys.length > 1) {
        try {
          let merged = toTurfPolygon(tilePolys[0]!);
          for (const poly of tilePolys.slice(1)) {
            const next = union(featureCollection([merged, toTurfPolygon(poly)]));
            if (next) merged = next as typeof merged;
          }
          footprint = merged.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
        } catch {
          footprint = undefined;
        }
      }

      const params = new URLSearchParams({
        date,
        composite: body.composite,
        size: "160",
      });
      if (body.ilrId) params.set("ilrId", body.ilrId);
      if (body.tehsilId) params.set("tehsilId", body.tehsilId);
      if (body.districtId) params.set("districtId", body.districtId);
      if (!body.ilrId && !body.tehsilId && !body.districtId && resolved.districtId) {
        params.set("districtId", resolved.districtId);
      }

      scenes.push({
        id: date,
        sceneId:
          tiles.length > 1
            ? `S2_DAILY_${date.replaceAll("-", "")}_${String(tiles.length).padStart(2, "0")}T`
            : best.id,
        date,
        time: best.datetime,
        cloudCover: minCloud,
        satellite: friendlySatellite(best.satellite),
        platformCode: platformCode(best.satellite),
        composite: body.composite,
        districtId: resolved.districtId,
        bbox: dayBBox(tiles),
        thumbnail: `${thumbnailBase.pathname}?${params.toString()}`,
        coverage,
        tileCount: tiles.length,
        products: toProducts(tiles),
        footprint,
      });
    }

    // Sort: full-coverage first, then lowest cloud, then newest.
    scenes.sort(
      (a, b) =>
        Number((b.coverage ?? 0) >= 90) - Number((a.coverage ?? 0) >= 90) ||
        a.cloudCover - b.cloudCover ||
        (a.date < b.date ? 1 : -1),
    );

    return NextResponse.json({ scenes: scenes.slice(0, MAX_RESULTS) });
  } catch (error) {
    return errorResponse(error);
  }
}
