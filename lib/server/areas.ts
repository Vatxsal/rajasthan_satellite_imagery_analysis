import { districtsFc, ilrsFc, resolveDistrictId, tehsilsFc } from "@/lib/data/boundaries";
import type { AreaLevel, BBox } from "@/lib/data";
import { bboxFromGeometry } from "@/lib/cdse/geometry";

/**
 * Server-side area lookup shared by /api/scenes, /api/imagery and /api/tiles.
 * Sources are the boundary datasets served by the data adapter
 * (data/boundaries/*.geojson — refreshed via scripts/fetch-districts-41.ts,
 * else the bundled mock boundaries). District ids accept alternate spellings
 * through resolveDistrictId.
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
  const districtId = resolveDistrictId(areaId);
  const feature = districtsFc.features.find((f) => f.properties?.id === districtId);
  if (!feature) return null;
  const geometry = feature.geometry as GeoJSON.Polygon;
  const bbox = bboxFromGeometry(geometry);
  if (!bbox) return null;
  return {
    level: "district",
    id: districtId,
    name: String(feature.properties?.name ?? districtId),
    districtId,
    geometry,
    bbox,
  };
}
