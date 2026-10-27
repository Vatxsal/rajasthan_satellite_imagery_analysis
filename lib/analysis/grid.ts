import type { BBox } from "@/lib/data";
import type { AnalysisGrid } from "./types";

/** Metres per degree at the equator (matches bboxAreaKm2 constants). */
const METERS_PER_DEG_LON = 111_320;
const METERS_PER_DEG_LAT = 110_574;

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
