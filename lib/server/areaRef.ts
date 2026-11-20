/**
 * Area references beyond the admin-boundary world.
 *
 * Compare/scenes/tiles address areas as { level, areaId } over the bundled
 * district/tehsil/ILR datasets (lib/server/areas.ts). Draw & analyze adds
 * freehand shapes: an AreaRef is the union both worlds speak, and
 * resolveAreaRef turns either kind into concrete geometry + bbox for
 * analysis. Shape refs run the same spec-order validation as the client
 * (server outline, never fail-open) and get a content-hash id so cache keys
 * stay stable across restarts and identical drawings deduplicate.
 */
import { createHash } from "node:crypto";
import { booleanPointInPolygon, centroid, feature } from "@turf/turf";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { districtsFc } from "@/lib/data/boundaries";
import type { AreaLevel, BBox } from "@/lib/data/types";
import { normalizeDrawGeometry, validateDrawGeometry } from "@/lib/draw/geometry";
import { resolveArea, type ResolvedArea } from "@/lib/server/areas";
import { serverDrawLimits } from "@/lib/server/drawLimits";
import { serverRajasthanOutline } from "@/lib/server/rajasthan";

export type AreaRef =
  | { kind: "admin"; level: AreaLevel; areaId: string }
  | { kind: "shape"; geometry: GeoJSON.Polygon; name?: string };

export interface ResolvedShapeArea {
  kind: "shape";
  /** `shape:<16 hex>` — sha256 of the normalised exterior ring. */
  id: string;
  name: string;
  geometry: GeoJSON.Polygon;
  bbox: BBox;
  /** District containing the polygon centroid ("" when none). */
  districtId: string;
}

export type ResolvedAreaRef = ({ kind: "admin" } & ResolvedArea) | ResolvedShapeArea;

/** Resolves an AreaRef, or null when it is unknown / fails validation. */
export function resolveAreaRef(ref: AreaRef): ResolvedAreaRef | null {
  if (ref.kind === "admin") {
    const area = resolveArea(ref.level, ref.areaId);
    return area ? { kind: "admin", ...area } : null;
  }

  // Validate the raw input first — normalising before validation would
  // silently repair an unclosed ring into a passing shape. Dedup happens
  // inside validateDrawGeometry already (Terra's double-seeded first click).
  const validity = validateDrawGeometry(ref.geometry, serverRajasthanOutline(), serverDrawLimits());
  if (!validity.ok) return null;
  const normalized = normalizeDrawGeometry(ref.geometry);
  if (normalized.type !== "Polygon") return null;
  const bbox = bboxFromGeometry(normalized);
  if (!bbox) return null;

  return {
    kind: "shape",
    id: `shape:${shapeHash(normalized)}`,
    name: ref.name?.trim() || "Custom shape",
    geometry: normalized,
    bbox,
    districtId: districtForPolygon(normalized),
  };
}

/** Content hash of the exterior ring (~0.1 m precision — float-noise stable). */
function shapeHash(geometry: GeoJSON.Polygon): string {
  const canonical = (geometry.coordinates[0] ?? [])
    .map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`)
    .join(";");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** District feature id containing the centroid ("" when outside all districts). */
function districtForPolygon(geometry: GeoJSON.Polygon): string {
  try {
    const point = centroid(feature(geometry));
    for (const district of districtsFc.features) {
      const g = district.geometry;
      if (
        g &&
        (g.type === "Polygon" || g.type === "MultiPolygon") &&
        booleanPointInPolygon(point, g)
      ) {
        return String(district.properties?.id ?? "");
      }
    }
  } catch {
    // Degenerate geometry — no containing district.
  }
  return "";
}
