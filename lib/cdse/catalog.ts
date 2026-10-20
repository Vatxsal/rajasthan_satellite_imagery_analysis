import type { BBox } from "@/lib/data";
import { getServerEnv } from "@/lib/env";
import { getAccessToken } from "./auth";
import { mapCdseStatus } from "./errors";

export interface CatalogQuery {
  bbox: BBox;
  /** ISO dates YYYY-MM-DD (inclusive). */
  from: string;
  to: string;
  maxCloud: number;
  limit?: number;
}

export interface CatalogHit {
  id: string;
  date: string;
  cloudCover: number;
  bbox: BBox;
  satellite: string;
  datetime: string;
  /** Tile footprint (WGS84), used for daily mosaicking + coverage math. */
  geometry: GeoJSON.Polygon | null;
}

interface StacFeature {
  id?: string;
  bbox?: number[];
  geometry?: GeoJSON.Geometry;
  properties?: {
    datetime?: string;
    "eo:cloud_cover"?: number;
    platform?: string;
  };
}

function bboxFromGeometry(geometry: GeoJSON.Geometry): BBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [x, y] = coords as [number, number];
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
      return;
    }
    for (const child of coords) visit(child);
  };

  visit((geometry as GeoJSON.Polygon).coordinates);
  if (!Number.isFinite(west)) return null;
  return [west, south, east, north];
}

/**
 * Searches the CDSE STAC catalogue (Sentinel-2 L2A) for a bounding box,
 * filtered by cloud cover and sorted lowest-cloud-first.
 */
export async function searchCatalog(query: CatalogQuery): Promise<CatalogHit[]> {
  const env = getServerEnv();
  const token = await getAccessToken();

  const response = await fetch(`${env.CDSE_SH_BASE_URL}/catalog/v1/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bbox: query.bbox,
      datetime: `${query.from}T00:00:00Z/${query.to}T23:59:59Z`,
      collections: ["sentinel-2-l2a"],
      // CQL2 JSON filter (STAC API filter extension).
      filter: {
        op: "<=",
        args: [{ property: "eo:cloud_cover" }, query.maxCloud],
      },
      "filter-lang": "cql2-json",
      limit: query.limit ?? 50,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw mapCdseStatus(response.status, await response.text().catch(() => ""));
  }

  const json = (await response.json()) as { features?: StacFeature[] };
  const hits: CatalogHit[] = [];

  for (const feature of json.features ?? []) {
    const datetime = feature.properties?.datetime;
    if (!datetime || !feature.id) continue;

    // Tile footprint for coverage math (largest polygon if MultiPolygon).
    let tileGeometry: GeoJSON.Polygon | null = null;
    if (feature.geometry?.type === "Polygon") {
      tileGeometry = feature.geometry as GeoJSON.Polygon;
    } else if (feature.geometry?.type === "MultiPolygon") {
      const polys = (feature.geometry as GeoJSON.MultiPolygon).coordinates.map(
        (coordinates) => ({ type: "Polygon", coordinates }) as GeoJSON.Polygon,
      );
      tileGeometry =
        polys.sort((a, b) => {
          const areaOf = (p: GeoJSON.Polygon) => {
            const bb = bboxFromGeometry(p);
            return bb ? Math.abs(bb[2] - bb[0]) * Math.abs(bb[3] - bb[1]) : 0;
          };
          return areaOf(b) - areaOf(a);
        })[0] ?? null;
    }

    const bbox =
      feature.bbox && feature.bbox.length === 4
        ? (feature.bbox as BBox)
        : feature.geometry
          ? bboxFromGeometry(feature.geometry)
          : null;
    if (!bbox) continue;

    hits.push({
      id: feature.id,
      date: datetime.slice(0, 10),
      // Keep the raw float — do NOT round; values like 0.04% are real.
      cloudCover: feature.properties?.["eo:cloud_cover"] ?? 0,
      bbox,
      satellite: feature.properties?.platform ?? "sentinel-2",
      datetime,
      geometry: tileGeometry,
    });
  }

  if (process.env.NODE_ENV !== "production") {
    console.info(
      `[cdse:catalog] ${hits.length} tiles raw eo:cloud_cover = ` +
        hits
          .map((h) => `${h.id.slice(-9, -5)}:${h.cloudCover}`)
          .join(" "),
    );
  }

  return hits;
}
