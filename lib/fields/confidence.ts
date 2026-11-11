/**
 * Field confidence sampling against the Fields of the World confidence COG
 * (data.source.coop, CC BY 4.0 — Robinson et al. 2026, arXiv:2605.11055).
 *
 * The raster stores PRUE model confidence scaled to 0..0.578178 with -1 as
 * nodata; percent confidence = raw / 0.578178 * 100 (the scale documented by
 * the dataset). A field's value is sampled at its point-on-surface.
 */
import type { BBox } from "@/lib/data";

/** Full-scale raw value of the confidence raster (100 %). */
export const CONF_FULL_SCALE = 0.578178;
/** Raster nodata marker (unmodelled pixel). */
export const CONF_NODATA = -1;

/** Raw raster value → 0..100 confidence, or null for nodata/invalid. */
export function rawToConfidence(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  const confidence = (raw / CONF_FULL_SCALE) * 100;
  return confidence > 100 ? 100 : confidence;
}

/** A small raster window read around the selection bbox. */
export interface ConfidenceWindow {
  /** West edge of the window (deg); pxLon eastwards. */
  west: number;
  /** North edge of the window (deg); pxLat southwards. */
  north: number;
  pxLon: number;
  pxLat: number;
  width: number;
  height: number;
  /** Band 0 values, row-major from the window's north-west corner. */
  values: ArrayLike<number>;
}

/** Nearest-cell sample; outside the window or nodata → null. */
export function sampleConfidence(
  window: ConfidenceWindow | null,
  lng: number,
  lat: number,
): number | null {
  if (!window) return null;
  const col = Math.floor((lng - window.west) / window.pxLon);
  const row = Math.floor((window.north - lat) / window.pxLat);
  if (col < 0 || row < 0 || col >= window.width || row >= window.height) return null;
  return rawToConfidence(window.values[row * window.width + col]);
}

/**
 * Reads a ~500 m-cell window of the confidence COG covering `bbox` (padded by
 * one cell). geotiff is imported dynamically so tests can stub it and the
 * route graph only pays for it when fields are actually requested.
 * Any failure returns null — confidence degrades to "unavailable", never to a
 * hard error.
 */
export async function readConfidenceWindow(
  url: string,
  bbox: BBox,
): Promise<ConfidenceWindow | null> {
  try {
    const { fromUrl } = await import("geotiff");
    const tiff = await fromUrl(url);
    const image = await tiff.getImage();
    const bounds = image.getBoundingBox(); // [west, south, east, north]
    const [imgWest, imgSouth, imgEast, imgNorth] = bounds;
    const [west, south, east, north] = bbox;
    if (east <= imgWest || west >= imgEast || north <= imgSouth || south >= imgNorth) {
      return null; // selection outside the raster footprint
    }

    const imageWidth = image.getWidth();
    const imageHeight = image.getHeight();
    const pxLon = (imgEast - imgWest) / imageWidth;
    const pxLat = (imgNorth - imgSouth) / imageHeight;

    const x0 = Math.max(0, Math.floor((west - imgWest) / pxLon) - 1);
    const x1 = Math.min(imageWidth, Math.ceil((east - imgWest) / pxLon) + 1);
    const y0 = Math.max(0, Math.floor((imgNorth - north) / pxLat) - 1);
    const y1 = Math.min(imageHeight, Math.ceil((imgNorth - south) / pxLat) + 1);
    if (x1 <= x0 || y1 <= y0) return null;

    const rasters = await image.readRasters({ window: [x0, y0, x1, y1] });
    const band = rasters[0];
    if (!band) return null;
    return {
      west: imgWest + x0 * pxLon,
      north: imgNorth - y0 * pxLat,
      pxLon,
      pxLat,
      width: x1 - x0,
      height: y1 - y0,
      values: band as ArrayLike<number>,
    };
  } catch {
    return null;
  }
}
