/**
 * Draw & analyze — shape measurement and live validation.
 *
 * The same rules run in the HUD while drawing and on the server in
 * POST /api/shapes/validate (Phase 2); reason order is fixed by spec:
 * structure → area → bbox side → vertices → self-intersection → inside
 * Rajasthan. `pending` states (not enough points yet) are not errors — the
 * HUD shows them neutrally and keeps Finish disabled.
 */
import {
  area as turfArea,
  booleanValid,
  featureCollection,
  intersect,
  kinks,
  length as turfLength,
} from "@turf/turf";
import {
  DRAW_MAX_BBOX_KM,
  DRAW_MAX_KM2,
  DRAW_MAX_VERTICES,
  RAJASTHAN_MIN_INSIDE_PCT,
  RAJASTHAN_OUTLINE_URL,
} from "@/lib/draw/constants";

export type DrawInvalidReason =
  | "structure"
  | "area"
  | "bbox"
  | "vertices"
  | "self-intersection"
  | "outside-rajasthan";

export type DrawValidity =
  | { ok: true }
  | { ok: false; kind: "pending" | "error"; reason: DrawInvalidReason; message: string };

export interface DrawMetrics {
  /** Geodesic area in m² (0 while the draft is still a LineString). */
  areaM2: number;
  /** Exterior-ring length in m. */
  perimeterM: number;
  /** Exterior-ring vertices, closing point excluded. */
  vertices: number;
  /** Longest side of the bounding box, in km (0 without a polygon). */
  bboxSideKm: number;
}

type DrawGeometry = GeoJSON.Polygon | GeoJSON.LineString;
export type RajasthanOutline = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

/**
 * Numeric shape ceilings. The client uses the defaults (lib/draw/constants);
 * the server passes DRAW_MAX_* from the env so a deployment can tighten or
 * loosen them — the server values are authoritative, the client copies only
 * keep live HUD feedback honest.
 */
export interface DrawLimits {
  maxKm2: number;
  maxBboxKm: number;
  maxVertices: number;
}

export const DEFAULT_DRAW_LIMITS: DrawLimits = {
  maxKm2: DRAW_MAX_KM2,
  maxBboxKm: DRAW_MAX_BBOX_KM,
  maxVertices: DRAW_MAX_VERTICES,
};

const PENDING_START: DrawValidity = {
  ok: false,
  kind: "pending",
  reason: "structure",
  message: "Tap the map to start.",
};

function pending(message: string, reason: DrawInvalidReason = "structure"): DrawValidity {
  return { ok: false, kind: "pending", reason, message };
}

function error(message: string, reason: DrawInvalidReason): DrawValidity {
  return { ok: false, kind: "error", reason, message };
}

/** Distinct vertices of a polygon exterior ring (closing point excluded). */
function polygonVertices(ring: GeoJSON.Position[]): number {
  return Math.max(0, ring.length - 1);
}

/**
 * Terra seeds the first click twice (`[p1,p1,p2,…]`), which would inflate
 * the vertex count and make kinks() see a degenerate zero-length segment.
 * Drop consecutive duplicates; rings stay closed.
 */
function dedupeRing(ring: GeoJSON.Position[]): GeoJSON.Position[] {
  const out: GeoJSON.Position[] = [];
  for (const pos of ring) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== pos[0] || prev[1] !== pos[1]) out.push(pos);
  }
  return out;
}

/** Normalised copy of a draft polygon (deduped, still closed). */
function normalizePolygon(geometry: GeoJSON.Polygon): GeoJSON.Polygon {
  const ring = dedupeRing(geometry.coordinates[0] ?? []);
  if (ring.length === 0) return geometry;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return { type: "Polygon", coordinates: [ring, ...geometry.coordinates.slice(1)] };
}

/** Canonical form of a draft: duplicate points dropped, rings kept closed. */
export function normalizeDrawGeometry(geometry: DrawGeometry): DrawGeometry {
  return geometry.type === "LineString"
    ? { type: "LineString", coordinates: dedupeRing(geometry.coordinates) }
    : normalizePolygon(geometry);
}

/** Bounding-box longest side in km (equirectangular approximation). */
function bboxSideKm(ring: GeoJSON.Position[]): number {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of ring) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  if (!Number.isFinite(west)) return 0;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const widthKm = Math.abs(east - west) * 111.32 * Math.cos(midLatRad);
  const heightKm = Math.abs(north - south) * 110.574;
  return Math.max(widthKm, heightKm);
}

/** Area (m²), perimeter (m), vertex count and bbox side (km) of a draft. */
export function measureDrawGeometry(geometry: DrawGeometry | null): DrawMetrics | null {
  if (!geometry) return null;
  if (geometry.type === "LineString") {
    const coords = dedupeRing(geometry.coordinates);
    const line: GeoJSON.Feature<GeoJSON.LineString> = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    };
    return {
      areaM2: 0,
      perimeterM: turfLength(line, { units: "meters" }),
      vertices: coords.length,
      bboxSideKm: 0,
    };
  }
  const poly = normalizePolygon(geometry);
  const feature: GeoJSON.Feature<GeoJSON.Polygon> = { type: "Feature", properties: {}, geometry: poly };
  const ring = poly.coordinates[0] ?? [];
  return {
    areaM2: turfArea(feature),
    perimeterM: turfLength(feature, { units: "meters" }),
    vertices: polygonVertices(ring),
    bboxSideKm: bboxSideKm(ring),
  };
}

function ringClosed(ring: GeoJSON.Position[]): boolean {
  if (ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/**
 * Validate a draft or committed shape against the Phase 1 rules.
 * `rajasthan` may be null while the outline is still loading — the
 * inside-check is then skipped and re-run by `revalidate` when it arrives.
 * `limits` defaults to the shared client constants; server routes pass the
 * DRAW_MAX_* env values (server values win).
 */
export function validateDrawGeometry(
  geometry: DrawGeometry | null,
  rajasthan: RajasthanOutline | null | undefined,
  limits: DrawLimits = DEFAULT_DRAW_LIMITS,
): DrawValidity {
  if (!geometry) return PENDING_START;

  if (geometry.type === "LineString") {
    const vertices = geometry.coordinates.length;
    return vertices < 3
      ? pending("Add at least 3 points.", "structure")
      : pending("Tap the first point to close, or press Enter.", "structure");
  }

  const rings = geometry.coordinates;
  if (rings.length > 1) {
    return error("Draw a single outline — holes are not supported.", "structure");
  }
  const rawRing = rings[0] ?? [];
  if (rawRing.length < 4 || !ringClosed(dedupeRing(rawRing))) {
    return pending("Add at least 3 points.", "structure");
  }

  const normalized = normalizePolygon(geometry);
  const ring = normalized.coordinates[0] ?? [];
  const poly: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: "Feature",
    properties: {},
    geometry: normalized,
  };
  const areaM2 = turfArea(poly);

  // Spec order: area → bbox → vertices → self-intersection → inside check.
  if (areaM2 === 0) {
    return pending("Add another point to give the shape an area.", "area");
  }
  if (areaM2 > limits.maxKm2 * 1e6) {
    return error(`Area exceeds the ${limits.maxKm2} km² limit.`, "area");
  }

  const sideKm = bboxSideKm(ring);
  if (sideKm > limits.maxBboxKm) {
    return error(
      `Shape spans ${sideKm.toFixed(1)} km — bounding-box limit is ${limits.maxBboxKm} km.`,
      "bbox",
    );
  }

  const vertices = polygonVertices(ring);
  if (vertices > limits.maxVertices) {
    return error(`${vertices} vertices — limit is ${limits.maxVertices}.`, "vertices");
  }

  if (kinks(poly).features.length > 0) {
    return error("Shape crosses itself — move the points so edges don't intersect.", "self-intersection");
  }
  if (!booleanValid(poly)) {
    return error("Shape is not a valid polygon.", "structure");
  }

  if (rajasthan) {
    const inside = intersect(featureCollection([poly, rajasthan]));
    const insideM2 = inside ? turfArea(inside) : 0;
    const pct = (insideM2 / areaM2) * 100;
    if (pct < RAJASTHAN_MIN_INSIDE_PCT) {
      return error(
        `${pct.toFixed(1)}% inside Rajasthan — at least ${RAJASTHAN_MIN_INSIDE_PCT}% is required.`,
        "outside-rajasthan",
      );
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------- Rajasthan outline */

let outlinePromise: Promise<RajasthanOutline | null> | null = null;

/**
 * Fetch the Rajasthan outline once and cache it for the session.
 * Fail-open: returns null (inside-check skipped) if the file can't load —
 * a network hiccup must not brick drawing; the server still enforces the
 * rule authoritatively.
 */
export function loadRajasthanOutline(): Promise<RajasthanOutline | null> {
  outlinePromise ??= (async () => {
    try {
      const response = await fetch(RAJASTHAN_OUTLINE_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return loadRajasthanOutlineFrom(await response.json());
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[draw] Rajasthan outline unavailable — inside-check skipped");
      return null;
    }
  })();
  return outlinePromise;
}

/**
 * Parsed outline from an already-loaded payload (the server imports the same
 * file from public/data — a relative fetch has no origin outside the browser).
 */
export function loadRajasthanOutlineFrom(json: unknown): RajasthanOutline | null {
  const geometry = normalizeOutline(json);
  return geometry ? { type: "Feature", properties: {}, geometry } : null;
}

function normalizeOutline(json: unknown): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as { type?: string; geometry?: GeoJSON.Geometry; features?: unknown[] };
  if (obj.type === "Feature" && obj.geometry) {
    return asPolygonal(obj.geometry);
  }
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    // Multi-part outlines arrive as a collection; merge into one geometry.
    const parts: GeoJSON.Polygon[] = [];
    for (const feature of obj.features) {
      const geometry = (feature as { geometry?: GeoJSON.Geometry })?.geometry;
      if (!geometry) continue;
      if (geometry.type === "Polygon") parts.push(geometry);
      else if (geometry.type === "MultiPolygon") parts.push(...geometry.coordinates.map(wrapPolygon));
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return { type: "MultiPolygon", coordinates: parts.map((p) => p.coordinates) };
  }
  return asPolygonal(obj as unknown as GeoJSON.Geometry);
}

function asPolygonal(geometry: GeoJSON.Geometry): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return geometry;
  return null;
}

function wrapPolygon(coordinates: GeoJSON.Position[][]): GeoJSON.Polygon {
  return { type: "Polygon", coordinates };
}
