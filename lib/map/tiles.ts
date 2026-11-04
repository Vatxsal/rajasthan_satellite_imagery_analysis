import type { CompositeId, Scene } from "@/lib/data";
import type { AreaLevel } from "@/lib/data";

/**
 * Builds the XYZ tile template for the /api/tiles native-resolution route.
 * Same-origin only — the browser never talks to sh.dataspace.copernicus.eu.
 */
export function buildTileUrl(input: {
  date: string;
  areaId: string;
  level: AreaLevel;
  composite: CompositeId;
}): string {
  const params = new URLSearchParams({
    date: input.date,
    composite: input.composite,
    areaId: input.areaId,
    level: input.level,
  });
  return `/api/tiles/{z}/{x}/{y}.png?${params.toString()}`;
}

/** Scene-based wrapper around buildTileUrl (change-map overlay path). */
export function buildTileUrlTemplate(input: {
  scene: Scene;
  areaId: string;
  level: AreaLevel;
  composite: CompositeId;
}): string {
  return buildTileUrl({
    date: input.scene.date,
    areaId: input.areaId,
    level: input.level,
    composite: input.composite,
  });
}
