import type { CompositeId, Scene } from "@/lib/data";
import type { AreaLevel } from "@/lib/data";

/**
 * Builds the XYZ tile template for the /api/tiles native-resolution route.
 * Same-origin only — the browser never talks to sh.dataspace.copernicus.eu.
 */
export function buildTileUrlTemplate(input: {
  scene: Scene;
  areaId: string;
  level: AreaLevel;
  composite: CompositeId;
}): string {
  const params = new URLSearchParams({
    date: input.scene.date,
    composite: input.composite,
    areaId: input.areaId,
    level: input.level,
  });
  return `/api/tiles/{z}/{x}/{y}.png?${params.toString()}`;
}
