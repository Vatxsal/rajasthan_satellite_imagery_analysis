/**
 * Map inspector — pure hit-testing / describing helpers (Phase 1).
 *
 * Everything here is deliberately dependency-light (turf only, no app imports;
 * maplibre appears only as a type-only structural pick) so the node test runner
 * can exercise exactly what the map handlers run: tap-vs-drag suppression, the
 * event > field > empty click priority, admin point-in-polygon, and the
 * plain-words basemap description.
 */
import { booleanPointInPolygon, point } from "@turf/turf";
import type { Map as MapLibreMap } from "maplibre-gl";

/** A click that moved further than this many px is a pan, not a tap. */
export const DRAG_CLICK_THRESHOLD_PX = 6;

export type InspectorHit =
  | { kind: "event"; rank: number; centroid: [number, number] }
  | { kind: "field"; fieldId: string }
  | { kind: "empty" };

/** Structural slice of a MapLibre query result (keeps this module map-free). */
export interface QueriedFeature {
  id?: string | number | null;
  properties?: Record<string, unknown> | null;
  geometry?: GeoJSON.Geometry;
  layer?: { id: string; type?: string; source?: string };
}

export interface HitQueryInput {
  eventFeatures: readonly QueriedFeature[];
  fieldFeatures: readonly QueriedFeature[];
}

function numberOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Priority for one map click: a change-event polygon beats a fields parcel,
 * anything else is an empty spot. (Administrative boundaries never capture
 * clicks — every point has one.)
 */
export function pickHit(input: HitQueryInput): InspectorHit {
  const event = input.eventFeatures[0];
  if (event) {
    const rank = numberOf(event.properties?.rank);
    const centroidRaw = event.properties?.centroid;
    const centroid: [number, number] =
      Array.isArray(centroidRaw) && centroidRaw.length === 2 && numberOf(centroidRaw[0]) !== null
        ? [Number(centroidRaw[0]), Number(centroidRaw[1])]
        : [NaN, NaN];
    if (rank !== null && rank > 0 && Number.isFinite(centroid[0])) {
      return { kind: "event", rank, centroid };
    }
  }
  const field = input.fieldFeatures[0];
  if (field) {
    const id = field.id ?? field.properties?.id;
    if (id !== undefined && id !== null && String(id).length > 0) {
      return { kind: "field", fieldId: String(id) };
    }
  }
  return { kind: "empty" };
}

/** True when the pointer moved far enough between down and up to be a pan. */
export function isDragClick(
  down: { x: number; y: number } | null,
  up: { x: number; y: number },
  thresholdPx: number = DRAG_CLICK_THRESHOLD_PX,
): boolean {
  if (!down) return false;
  return Math.hypot(up.x - down.x, up.y - down.y) > thresholdPx;
}

/* ------------------------------------------------------------------ admin PIP */

export interface AdminAreaRef {
  id: string;
  name: string;
  districtId?: string;
  tehsilId?: string;
  geometry: GeoJSON.Polygon;
}

export interface AdminHit {
  district: AdminAreaRef | null;
  tehsil: AdminAreaRef | null;
  ilr: AdminAreaRef | null;
}

export interface AdminFcLike {
  features: ReadonlyArray<{
    id?: string | number;
    geometry?: GeoJSON.Geometry | null;
    properties?: Record<string, unknown> | null;
  }>;
}

const bboxCache = new WeakMap<object, [number, number, number, number] | null>();

function featureBbox(
  feature: NonNullable<AdminFcLike["features"][number]>,
): [number, number, number, number] | null {
  const cached = bboxCache.get(feature as object);
  if (cached !== undefined) return cached;
  let result: [number, number, number, number] | null = null;
  const geometry = feature.geometry;
  if (geometry && geometry.type === "Polygon") {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const ring of geometry.coordinates) {
      for (const [lng, lat] of ring) {
        if (lng < west) west = lng;
        if (lat < south) south = lat;
        if (lng > east) east = lng;
        if (lat > north) north = lat;
      }
    }
    if (Number.isFinite(west)) result = [west, south, east, north];
  }
  bboxCache.set(feature as object, result);
  return result;
}

function refOf(
  feature: NonNullable<AdminFcLike["features"][number]>,
): AdminAreaRef | null {
  const props = feature.properties ?? {};
  const id = String(props.id ?? feature.id ?? "");
  const name = String(props.name ?? "");
  if (!name || !feature.geometry || feature.geometry.type !== "Polygon") return null;
  return {
    id,
    name,
    ...(typeof props.districtId === "string" ? { districtId: props.districtId } : {}),
    ...(typeof props.tehsilId === "string" ? { tehsilId: props.tehsilId } : {}),
    geometry: feature.geometry,
  };
}

function findContaining(fc: AdminFcLike, lng: number, lat: number): AdminAreaRef | null {
  const p = point([lng, lat]);
  for (const feature of fc.features) {
    if (!feature.geometry || feature.geometry.type !== "Polygon") continue;
    const bbox = featureBbox(feature as NonNullable<AdminFcLike["features"][number]>);
    if (!bbox) continue;
    if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
    if (booleanPointInPolygon(p, feature.geometry as GeoJSON.Polygon)) return refOf(feature);
  }
  return null;
}

function byId(fc: AdminFcLike, id: string | undefined): AdminAreaRef | null {
  if (!id) return null;
  for (const feature of fc.features) {
    const props = feature.properties ?? {};
    if (String(props.id ?? feature.id ?? "") === id) return refOf(feature);
  }
  return null;
}

/**
 * District / tehsil / ILR containing a lng/lat, cascading ids so a point
 * inside an ILR also reports its tehsil and district even when the direct
 * lookup missed (bbox rejects are cheap; turf runs only on bbox hits).
 */
export function pipAdminAgainst(
  districts: AdminFcLike,
  tehsils: AdminFcLike,
  ilrs: AdminFcLike,
  lng: number,
  lat: number,
): AdminHit {
  const ilr = findContaining(ilrs, lng, lat);
  const tehsil = findContaining(tehsils, lng, lat) ?? byId(tehsils, ilr?.tehsilId);
  const district = findContaining(districts, lng, lat) ?? byId(districts, tehsil?.districtId ?? ilr?.districtId);
  return { district, tehsil, ilr };
}

/* --------------------------------------------------------- basemap wording */

/** Layers the app adds itself — never useful as "where am I" context. */
const CUSTOM_LAYER_PREFIXES = [
  "admin-",
  "districts-",
  "tehsils-",
  "ilrs-",
  "selection",
  "active-scene",
  "imagery",
  "fields-",
  "compare-",
  "hotspot",
  "shimmer",
  "scene-",
  "state-outline",
  "measure-",
  "td-",
];

export function isCustomLayer(layerId: string): boolean {
  return CUSTOM_LAYER_PREFIXES.some((prefix) => layerId.startsWith(prefix));
}

/** OSM-style class/type tokens → words anyone reads the same way. */
function plainWord(value: unknown, layerType?: string): string | null {
  if (typeof value !== "string" || !value) return null;
  const map: Record<string, string> = {
    motorway: "highway",
    trunk: "highway",
    primary: "road",
    secondary: "road",
    tertiary: "road",
    motorway_link: "highway ramp",
    primary_link: "road",
    minor: "street",
    residential: layerType === "fill" ? "built-up area" : "street",
    service: "service road",
    track: "track",
    path: "path",
    footway: "footpath",
    cycleway: "cycleway",
    pedestrian: "pedestrian street",
    river: "river",
    stream: "stream",
    canal: "canal",
    riverbank: "riverbank",
    wetland: "wetland",
    grass: "grassland",
    meadow: "grassland",
    farmland: "farmland",
    farm: "farmland",
    forest: "forest",
    wood: "forest",
    park: "park",
    garden: "garden",
    scrub: "scrub",
    built: "built-up area",
    industrial: "industrial area",
    commercial: "commercial area",
    cemetery: "cemetery",
    place: "place",
    city: "city",
    town: "town",
    village: "village",
    hamlet: "hamlet",
    suburb: "suburb",
    locality: "locality",
    neighbourhood: "neighbourhood",
  };
  const mapped = map[value.toLowerCase()];
  if (mapped) return mapped;
  const word = value.replace(/_/g, " ");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Plain-words description of what sits under a map point: named features
 * first (label + type), then shapeless water/landuse classes. Custom app
 * layers are excluded; output is deduped and capped.
 */
export function describeQueriedFeatures(features: readonly QueriedFeature[], cap = 6): string[] {
  const named: string[] = [];
  const typed: string[] = [];
  for (const feature of features) {
    const layerId = feature.layer?.id ?? "";
    if (!layerId || isCustomLayer(layerId)) continue;
    const props = feature.properties ?? {};
    const layerType = feature.layer?.type;
    const name =
      (typeof props.name === "string" && props.name) ||
      (typeof props.name_en === "string" && props.name_en) ||
      null;
    const type = plainWord(props.class ?? props.type, layerType);
    if (name && type && type.toLowerCase() !== name.toLowerCase()) {
      named.push(`${name} — ${type}`);
    } else if (name) {
      named.push(name);
    } else if (type && layerType !== "symbol") {
      typed.push(type);
    }
  }
  const out: string[] = [];
  for (const entry of [...named, ...typed]) {
    if (!out.includes(entry)) out.push(entry);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Minimal map surface the basemap helper needs: whatever MapLibre exposes for
 * `queryRenderedFeatures` (so a real map instance just fits, while tests can
 * stub it with the same call shape).
 */
export type MapQueryable = Pick<MapLibreMap, "queryRenderedFeatures">;

/**
 * Basemap words at a screen point (streets mode only — the satellite
 * basemap has no labels worth querying; Nominatim covers that mode).
 */
export function basemapWordsAt(
  map: MapQueryable,
  screenPoint: { x: number; y: number } | readonly [number, number],
): string[] {
  try {
    // `as never`: the screen-point input always matches a MapLibre overload
    // (Point or lng/lat tuple), but the overloaded union is awkward to name.
    return describeQueriedFeatures(map.queryRenderedFeatures(screenPoint as never));
  } catch {
    return []; // style mid-reload — the section just shows no basemap rows
  }
}
