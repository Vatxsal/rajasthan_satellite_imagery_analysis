/**
 * Map inspector — pure change-section logic (Phase 1).
 *
 * Reads one pixel from the classified raster of a completed analysis and
 * resolves the patch polygon it falls in. Kept free of server/framework
 * imports (config only, via relative path) so the node test runner can
 * exercise exactly what /api/compare/inspect returns.
 */
import { booleanPointInPolygon, point } from "@turf/turf";
import { CLASS, classLabel } from "../analysis/config";

export type ChangeKind = "change" | "none" | "masked" | "outside";

export interface ChangePatchInfo {
  id: string;
  areaHa: number;
  confidence: string | null;
  confidencePct: number | null;
  evidence: string | null;
}

export interface ChangeInspectResult {
  kind: ChangeKind;
  classCode: number;
  classLabel: string;
  patch: ChangePatchInfo | null;
}

export interface ClassGridRef {
  /** Row-major uint8 class codes (inflateSync output of entry.classGz). */
  grid: Uint8Array;
  width: number;
  height: number;
  bbox: [number, number, number, number];
}

interface PatchFeatureLike {
  properties?: Record<string, unknown> | null;
  geometry?: GeoJSON.Geometry | null;
}

const LABELS: Record<ChangeKind, string> = {
  change: "",
  none: "No change",
  masked: "Masked (clouds / no data)",
  outside: "",
};

/**
 * Class + patch under a lng/lat point. The point is mapped north-up
 * (row = (north - lat) / pxLat) exactly like the overlay render, clamped to
 * the grid, and `outside` short-circuits before any pixel read.
 */
export function inspectChangeAt(
  input: ClassGridRef,
  features: ReadonlyArray<PatchFeatureLike>,
  lng: number,
  lat: number,
): ChangeInspectResult {
  const [west, south, east, north] = input.bbox;
  if (lng < west || lng > east || lat < south || lat > north) {
    return { kind: "outside", classCode: CLASS.outside, classLabel: LABELS.outside, patch: null };
  }
  const pxLon = (east - west) / input.width;
  const pxLat = (north - south) / input.height;
  const col = Math.min(input.width - 1, Math.max(0, Math.floor((lng - west) / pxLon)));
  const row = Math.min(input.height - 1, Math.max(0, Math.floor((north - lat) / pxLat)));
  const code = input.grid[row * input.width + col] ?? CLASS.outside;

  const kind: ChangeKind =
    code === CLASS.noChange
      ? "none"
      : code === CLASS.masked
        ? "masked"
        : code === CLASS.outside
          ? "outside"
          : "change";

  return {
    kind,
    classCode: code,
    classLabel: kind === "change" ? classLabel(code) : LABELS[kind],
    patch: kind === "change" ? findPatchAt(features, lng, lat) : null,
  };
}

/** Point-in-polygon over the vectorized patches (bbox-rejected first). */
export function findPatchAt(
  features: ReadonlyArray<PatchFeatureLike>,
  lng: number,
  lat: number,
): ChangePatchInfo | null {
  const probe = point([lng, lat]);
  for (const feature of features) {
    const props = (feature.properties ?? {}) as {
      id?: unknown;
      areaHa?: unknown;
      confidence?: unknown;
      confidencePct?: unknown;
      subLabel?: unknown;
      bbox?: unknown;
    };
    const bbox = Array.isArray(props.bbox) && props.bbox.length === 4 ? props.bbox : null;
    if (bbox) {
      const [w, s, e, n] = bbox.map(Number);
      if (lng < w || lng > e || lat < s || lat > n) continue;
    }
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) continue;
    if (!booleanPointInPolygon(probe, geometry)) continue;
    return {
      id: String(props.id ?? ""),
      areaHa: Number(props.areaHa ?? 0),
      confidence: typeof props.confidence === "string" ? props.confidence : null,
      confidencePct:
        typeof props.confidencePct === "number" && Number.isFinite(props.confidencePct)
          ? Math.round(props.confidencePct)
          : null,
      evidence: typeof props.subLabel === "string" && props.subLabel ? props.subLabel : null,
    };
  }
  return null;
}
