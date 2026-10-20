import { districtsFc, ilrsFc, tehsilsFc } from "@/lib/data/boundaries";
import type { AreaLevel, BBox } from "@/lib/data";
import { bboxFromGeometry } from "@/lib/cdse/geometry";

/**
 * Server-side area lookup shared by /api/scenes, /api/imagery and /api/tiles.
 * Sources are the boundary datasets served by the data adapter
 * (data/boundaries/*.geojson once populated via scripts/fetch-datameet.ts,
 * else the bundled mock boundaries).
 */

export interface ResolvedArea {
  level: AreaLevel;
  id: string;
  name: string;
  districtId: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  bbox: BBox;
}

export function resolveArea(level: AreaLevel, areaId: string): ResolvedArea | null {
  if (level === "ilr") {
    const feature = ilrsFc.features.find((f) => f.properties?.id === areaId);
    if (!feature) return null;
    const geometry = feature.geometry as GeoJSON.Polygon;
    const bbox = bboxFromGeometry(geometry);
    if (!bbox) return null;
    return {
      level,
      id: areaId,
      name: String(feature.properties?.name ?? areaId),
      districtId: String(feature.properties?.districtId ?? ""),
      geometry,
      bbox,
    };
  }
  if (level === "tehsil") {
    const feature = tehsilsFc.features.find((f) => f.properties?.id === areaId);
    if (!feature) return null;
    const geometry = feature.geometry as GeoJSON.Polygon;
    const bbox = bboxFromGeometry(geometry);
    if (!bbox) return null;
    return {
      level,
      id: areaId,
      name: String(feature.properties?.name ?? areaId),
      districtId: String(feature.properties?.districtId ?? ""),
      geometry,
      bbox,
    };
  }
  const feature = districtsFc.features.find((f) => f.properties?.id === areaId);
  if (!feature) return null;
  const geometry = feature.geometry as GeoJSON.Polygon;
  const bbox = bboxFromGeometry(geometry);
  if (!bbox) return null;
  return {
    level: "district",
    id: areaId,
    name: String(feature.properties?.name ?? areaId),
    districtId: areaId,
    geometry,
    bbox,
  };
}
