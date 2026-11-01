import type { BBox } from "@/lib/data";
import { GRID_NATIVE_RES_M } from "./config";
import type { AnalysisGrid } from "./types";

/** Metres per degree at the equator (matches bboxAreaKm2 constants). */
const METERS_PER_DEG_LON = 111_320;
const METERS_PER_DEG_LAT = 110_574;

/**
 * Long side of the bbox expressed in native 10 m Sentinel-2 pixels — the
 * honest ceiling for the analysis grid (#14): below COMPARE_MAX_PX the grid
 * now runs at native resolution instead of being upscaled to the cap.
 */
export function nativeLongSidePx(bbox: BBox): number {
  const [west, south, east, north] = bbox;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const metersX = Math.abs(east - west) * METERS_PER_DEG_LON * Math.cos(midLatRad);
  const metersY = Math.abs(north - south) * METERS_PER_DEG_LAT;
  return Math.max(metersX, metersY) / GRID_NATIVE_RES_M;
}

/** Linear grid mapping of the request bbox onto width × height pixels. */
export function makeAnalysisGrid(bbox: BBox, width: number, height: number): AnalysisGrid {
  const [west, south, east, north] = bbox;
  const pxLon = Math.abs(east - west) / width;
  const pxLat = Math.abs(north - south) / height;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const metersX = pxLon * METERS_PER_DEG_LON * Math.cos(midLatRad);
  const metersY = pxLat * METERS_PER_DEG_LAT;
  return {
    width,
    height,
    bbox: [west, south, east, north],
    pxLon,
    pxLat,
    metersX,
    metersY,
    metersPerPixel: Math.max(metersX, metersY),
  };
}
