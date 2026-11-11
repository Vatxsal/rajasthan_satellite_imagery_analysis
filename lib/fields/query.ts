/**
 * Field boundary extraction pipeline (Phase 1 of the Fields & cropping
 * pattern demo): read z13 tiles from the Fields of the World IN_RJ PMTiles
 * archive over HTTP range requests, keep the features whose point-on-surface
 * falls inside the selection bbox, merge cross-tile duplicates, attach
 * confidence sampled from the FTW confidence COG, and hand back a cacheable
 * raw entry. Pure response shaping (thresholds, caps, counters) lives in
 * filterFields so one build serves every minConfidence.
 *
 * Data: Fields of the World, CC BY 4.0, via Source Cooperative (see
 * lib/fields/config.ts for the attribution strings).
 *
 * No `next/server` imports here — contract errors are plain duck-typed
 * { status, code } errors so the test harness can exercise this module
 * without pulling the Next.js runtime.
 */
import { createHash } from "node:crypto";
import {
  area as turfArea,
  bboxPolygon,
  booleanPointInPolygon,
  feature,
  featureCollection,
  intersect,
  pointOnFeature,
  union,
} from "@turf/turf";
import type { BBox } from "@/lib/data";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import {
  FIELDS_BUILD_CAP,
  FIELDS_EDGE_EPS_DEG,
  FIELDS_MAX_TILES,
  FIELDS_MERGE_MIN_OVERLAP,
  FIELDS_TILE_ZOOM,
  FIELDS_TINY_M2,
  FIELDS_HUGE_M2,
} from "./config";
import { sampleConfidence, type ConfidenceWindow } from "./confidence";
import { decodeMvt, mvtGeometryToGeoJSON } from "./mvt";
import { PmtilesReader, type RangeReader } from "./pmtiles";

export type FieldsYear = 2024 | 2025;

/** Duck-typed contract error understood by lib/server/api errorResponse(). */
export function fieldsError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

export function isContractError(error: unknown): error is { status: number; code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

export interface FieldProperties {
  /** Source `metrics:area` in m² (merged copies keep the larger value). */
  areaM2: number;
  /** Sampled confidence 0..100; null when unavailable/nodata. */
  confidence: number | null;
  flag?: "tiny" | "huge";
}

export type FieldFeature = GeoJSON.Feature<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  FieldProperties
>;

/** One candidate field geometry from a single tile (pre-merge). */
export interface FieldCandidate {
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  areaM2: number;
  /** Precomputed geometry bbox (degrees) — powers the merge prefilters. */
  bbox: BBox;
  tileX: number;
  tileY: number;
}

export interface FieldsDeps {
  readRange: RangeReader;
  readConfidence: (bbox: BBox) => Promise<ConfidenceWindow | null>;
}

export interface FieldsRawEntry {
  bbox: BBox;
  year: FieldsYear;
  /** Whether a confidence raster window could be read for this selection. */
  confidenceAvailable: boolean;
  /** Sorted by areaM2 descending, capped at FIELDS_BUILD_CAP. */
  features: FieldFeature[];
}

export interface FieldsFiltered {
  count: number;
  truncated: boolean;
  excluded: { confidence: number; noConfidence: number };
  totalAreaM2: number;
  fields: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, FieldProperties>;
}

/** All z13 tiles overlapping the bbox; throws 400 AREA_TOO_LARGE past the cap. */
export function tilesForBbox(bbox: BBox, zoom: number): Array<{ x: number; y: number }> {
  const [west, south, east, north] = bbox;
  const n = 2 ** zoom;
  const clamp = (value: number): number => Math.min(n - 1, Math.max(0, value));
  const lonToX = (lon: number): number => clamp(Math.floor(((lon + 180) / 360) * n));
  const latToY = (lat: number): number => {
    const rad = (lat * Math.PI) / 180;
    const mercator = 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI);
    return clamp(Math.floor(mercator * n));
  };

  const x0 = lonToX(west);
  const x1 = lonToX(east);
  const y0 = latToY(north);
  const y1 = latToY(south);
  if (x1 < x0 || y1 < y0) return [];

  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > FIELDS_MAX_TILES) {
    throw fieldsError(
      400,
      "AREA_TOO_LARGE",
      `Selected area spans ${count} map tiles (limit ${FIELDS_MAX_TILES}) — ` +
        "please draw a smaller, more compact area.",
    );
  }

  const tiles: Array<{ x: number; y: number }> = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) tiles.push({ x, y });
  }
  return tiles;
}

function tileWestLon(zoom: number, x: number): number {
  return (x / 2 ** zoom) * 360 - 180;
}

function tileNorthLat(zoom: number, y: number): number {
  const mercator = y / 2 ** zoom;
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercator))) * 180) / Math.PI;
}

function bboxOverlap(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Removes tippecanoe cross-tile twins: the same field is written into every
 * tile whose padded bounds cover it, so features within `epsDeg` of a shared
 * tile edge are pair-tested (bbox prefilter → polygon intersection ratio ≥
 * FIELDS_MERGE_MIN_OVERLAP of the smaller) and merged with turf.union.
 * Union failure keeps the larger copy; non-adjacent tiles are never tested.
 */
export function mergeEdgeDuplicates(
  candidates: FieldCandidate[],
  options: { zoom: number; epsDeg: number },
): FieldCandidate[] {
  const { zoom, epsDeg } = options;
  const all: FieldCandidate[] = [];
  const parent: number[] = [];
  const groups = new Map<string, number[]>();

  for (const candidate of candidates) {
    const index = all.length;
    all.push(candidate);
    parent.push(index);
    const key = `${candidate.tileX},${candidate.tileY}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(index);
    else groups.set(key, [index]);
  }

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const join = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const testPair = (leftIndex: number, rightIndex: number): void => {
    const left = all[leftIndex];
    const right = all[rightIndex];
    if (!bboxOverlap(left.bbox, right.bbox)) return;
    let overlap: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
    try {
      overlap = intersect(
        featureCollection([feature(left.geometry), feature(right.geometry)]),
      );
    } catch {
      return; // invalid ring — treat as distinct
    }
    if (!overlap) return;
    const minArea = Math.min(turfArea(left.geometry), turfArea(right.geometry));
    if (minArea <= 0) return;
    if (turfArea(overlap) / minArea >= FIELDS_MERGE_MIN_OVERLAP) {
      join(leftIndex, rightIndex);
    }
  };

  // Every orthogonal tile pair is visited once: (x,y) with (x+1,y) and (x,y+1).
  for (const [key, leftIndices] of groups) {
    const [tileX, tileY] = key.split(",").map(Number);
    for (const [deltaX, deltaY] of [
      [1, 0],
      [0, 1],
    ]) {
      const neighbour = groups.get(`${tileX + deltaX},${tileY + deltaY}`);
      if (!neighbour) continue;

      if (deltaX === 1) {
        const edgeLon = tileWestLon(zoom, tileX + 1);
        const leftStrip = leftIndices.filter(
          (index) => all[index].bbox[2] >= edgeLon - epsDeg,
        );
        const rightStrip = neighbour.filter((index) => all[index].bbox[0] <= edgeLon + epsDeg);
        for (const left of leftStrip) {
          for (const right of rightStrip) testPair(left, right);
        }
      } else {
        const edgeLat = tileNorthLat(zoom, tileY + 1);
        const topStrip = leftIndices.filter(
          (index) => all[index].bbox[1] <= edgeLat + epsDeg,
        );
        const bottomStrip = neighbour.filter(
          (index) => all[index].bbox[3] >= edgeLat - epsDeg,
        );
        for (const top of topStrip) {
          for (const bottom of bottomStrip) testPair(top, bottom);
        }
      }
    }
  }

  const components = new Map<number, FieldCandidate[]>();
  for (let index = 0; index < all.length; index++) {
    const root = find(index);
    const bucket = components.get(root);
    if (bucket) bucket.push(all[index]);
    else components.set(root, [all[index]]);
  }
  if (components.size === all.length) return all;

  const merged: FieldCandidate[] = [];
  for (const members of components.values()) {
    if (members.length === 1) {
      merged.push(members[0]);
      continue;
    }
    let geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;
    try {
      const united = union(
        featureCollection(members.map((member) => feature(member.geometry))),
      );
      if (united && (united.geometry.type === "Polygon" || united.geometry.type === "MultiPolygon")) {
        geometry = united.geometry;
      }
    } catch {
      geometry = null;
    }
    if (geometry) {
      merged.push({
        geometry,
        areaM2: Math.max(...members.map((member) => member.areaM2)),
        bbox: members[0].bbox,
        tileX: members[0].tileX,
        tileY: members[0].tileY,
      });
    } else {
      // Union failed — keep the largest copy rather than two partials.
      merged.push(
        members.reduce((best, member) => (member.areaM2 > best.areaM2 ? member : best)),
      );
    }
  }
  return merged;
}

function bboxContains(outer: BBox, inner: BBox): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function bboxDisjoint(a: BBox, b: BBox): boolean {
  return a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1];
}

/**
 * Builds the cacheable raw entry for one (bbox, year): tile fetches are
 * all-or-nothing (any range/decode failure → 503 FIELDS_UNAVAILABLE, empty
 * tiles simply contribute nothing), confidence failures degrade to
 * `confidenceAvailable: false`.
 */
export async function buildFieldsRaw(
  deps: FieldsDeps,
  request: { bbox: BBox; year: FieldsYear },
): Promise<FieldsRawEntry> {
  const { bbox, year } = request;
  const tiles = tilesForBbox(bbox, FIELDS_TILE_ZOOM);
  const reader = new PmtilesReader(deps.readRange);
  const selectionPolygon = bboxPolygon(bbox);
  const candidates: FieldCandidate[] = [];

  try {
    const perTile = await Promise.all(
      tiles.map(async (tile) => {
        const bytes = await reader.getTile(FIELDS_TILE_ZOOM, tile.x, tile.y);
        if (!bytes) return [];
        const layer = decodeMvt(bytes).get(String(year));
        if (!layer) return [];

        const found: FieldCandidate[] = [];
        for (const feature of layer.features) {
          const geometry = mvtGeometryToGeoJSON(
            feature.type,
            feature.rings,
            FIELDS_TILE_ZOOM,
            tile.x,
            tile.y,
            layer.extent,
          );
          if (
            geometry === null ||
            (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
          ) {
            continue;
          }
          const areaM2 = Number(feature.properties["metrics:area"]);
          if (!Number.isFinite(areaM2) || areaM2 <= 0) continue;
          const geometryBbox = bboxFromGeometry(geometry);
          if (!geometryBbox) continue;
          if (bboxDisjoint(geometryBbox, bbox)) continue;
          const representativePoint = bboxContains(bbox, geometryBbox)
            ? null
            : pointOnFeature({ type: "Feature", geometry, properties: {} });
          if (
            representativePoint &&
            !booleanPointInPolygon(representativePoint, selectionPolygon)
          ) {
            continue;
          }
          found.push({ geometry, areaM2, bbox: geometryBbox, tileX: tile.x, tileY: tile.y });
        }
        return found;
      }),
    );
    for (const found of perTile) candidates.push(...found);
  } catch (error) {
    if (isContractError(error)) throw error;
    throw fieldsError(
      503,
      "FIELDS_UNAVAILABLE",
      "Field boundary data is temporarily unavailable. Try again shortly.",
    );
  }

  const merged = mergeEdgeDuplicates(candidates, {
    zoom: FIELDS_TILE_ZOOM,
    epsDeg: FIELDS_EDGE_EPS_DEG,
  });

  let confidenceWindow: ConfidenceWindow | null = null;
  if (merged.length > 0) {
    try {
      confidenceWindow = await deps.readConfidence(bbox);
    } catch {
      confidenceWindow = null;
    }
  }

  const features: FieldFeature[] = merged.map((candidate) => {
    const point = pointOnFeature({
      type: "Feature",
      geometry: candidate.geometry,
      properties: {},
    });
    const [lng, lat] = point.geometry.coordinates;
    const confidence = sampleConfidence(confidenceWindow, lng, lat);
    const properties: FieldProperties = { areaM2: candidate.areaM2, confidence };
    if (candidate.areaM2 < FIELDS_TINY_M2) properties.flag = "tiny";
    else if (candidate.areaM2 > FIELDS_HUGE_M2) properties.flag = "huge";
    const id = createHash("sha1")
      .update(`${year}:${candidate.areaM2}:${lng.toFixed(5)}:${lat.toFixed(5)}`)
      .digest("hex")
      .slice(0, 12);
    return { type: "Feature", id, geometry: candidate.geometry, properties };
  });

  features.sort((a, b) => b.properties.areaM2 - a.properties.areaM2);
  return {
    bbox,
    year,
    confidenceAvailable: confidenceWindow !== null,
    features: features.slice(0, FIELDS_BUILD_CAP),
  };
}

/**
 * Per-request shaping of a raw entry: confidence threshold, response cap and
 * exclusion counters. minConfidence ≤ 0 keeps everything (including fields
 * with unknown confidence).
 */
export function filterFields(
  entry: FieldsRawEntry,
  minConfidence: number,
  maxCount: number,
): FieldsFiltered {
  const excluded = { confidence: 0, noConfidence: 0 };
  const kept: FieldFeature[] = [];
  let truncated = false;
  let totalAreaM2 = 0;

  for (const feature of entry.features) {
    if (minConfidence > 0) {
      const confidence = feature.properties.confidence;
      if (confidence === null) {
        excluded.noConfidence += 1;
        continue;
      }
      if (confidence < minConfidence) {
        excluded.confidence += 1;
        continue;
      }
    }
    if (kept.length >= maxCount) {
      truncated = true;
      continue;
    }
    kept.push(feature);
    totalAreaM2 += feature.properties.areaM2;
  }

  return {
    count: kept.length,
    truncated,
    excluded,
    totalAreaM2,
    fields: { type: "FeatureCollection", features: kept },
  };
}

const RANGE_TIMEOUT_MS = 15_000;

/**
 * HTTP Range reader for the PMTiles archive. Strict on purpose: only a 206 of
 * exactly the requested length is trusted; a server that ignores Range (200
 * with a multi-GB body) is aborted instead of being downloaded.
 */
export function httpRangeReader(url: string): RangeReader {
  return async (offset: number, length: number): Promise<Uint8Array> => {
    if (length <= 0) return new Uint8Array(0);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        signal: AbortSignal.timeout(RANGE_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw fieldsError(503, "FIELDS_UNAVAILABLE", "Field boundary service is unreachable.");
    }

    if (response.status === 206) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== length) {
        throw fieldsError(
          503,
          "FIELDS_UNAVAILABLE",
          `Field boundary service returned ${bytes.byteLength} of ${length} requested bytes.`,
        );
      }
      return bytes;
    }

    if (response.status === 200) {
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > length + 1024) {
        // The server ignored our Range header — never read a 3 GB body.
        await response.body?.cancel();
        throw fieldsError(
          503,
          "FIELDS_UNAVAILABLE",
          "Field boundary service does not support range requests.",
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < length) {
        throw fieldsError(
          503,
          "FIELDS_UNAVAILABLE",
          "Field boundary service returned a short response.",
        );
      }
      return bytes.subarray(0, length);
    }

    await response.body?.cancel();
    throw fieldsError(
      503,
      "FIELDS_UNAVAILABLE",
      `Field boundary service responded with HTTP ${response.status}.`,
    );
  };
}
