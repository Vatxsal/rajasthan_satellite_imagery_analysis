/**
 * Engine-v2 composite inputs: the time window around each comparison date and
 * the client-side index derivation from the 9-band composite raster.
 *
 * The composite evalscript returns median reflectances; NDVI/MNDWI/NDBI are
 * recomputed here with the *exact* v1 evalscript formulas (same zero-denominator
 * convention) so the v1 classifier sees identical inputs until Phase 2 replaces
 * it with the multi-index engine.
 */
import type { IndexRasters } from "./types";

export interface CompositeBands {
  b02: Float32Array;
  b03: Float32Array;
  b04: Float32Array;
  b05: Float32Array;
  b08: Float32Array;
  b11: Float32Array;
  b12: Float32Array;
}

export interface CompositeTimeRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

function isoNoMillis(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * ±windowDays around `date`, capped at the midpoint between the two comparison
 * dates so A's and B's windows can never share a scene (which would suppress
 * the very change being measured). windowDays 0 → the single day.
 */
export function compositeTimeRange(
  date: string,
  windowDays: number,
  otherDate?: string,
): CompositeTimeRange {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(start)) {
    throw Object.assign(new Error("Invalid composite date."), {
      status: 400,
      code: "INVALID_DATE",
    });
  }
  const days = Math.min(Math.max(windowDays, 0), 366);
  let from = start - days * DAY_MS;
  let to = start + DAY_MS - 1000;

  if (otherDate) {
    const other = Date.parse(`${otherDate}T00:00:00Z`);
    if (!Number.isNaN(other) && other !== start) {
      const mid = (start + other) / 2;
      if (other > start) to = Math.min(to, mid);
      else from = Math.max(from, mid);
    }
  }
  return { from: isoNoMillis(from), to: isoNoMillis(to) };
}

/**
 * NDVI / MNDWI / NDBI from median-reflectance bands — byte-for-byte parity
 * with the v1 evalscript (denominator 0 → index 0).
 */
export function deriveIndices(bands: CompositeBands): IndexRasters {
  const n = bands.b04.length;
  const ndvi = new Float32Array(n);
  const mndwi = new Float32Array(n);
  const ndbi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ndviDen = bands.b08[i] + bands.b04[i];
    const mndwiDen = bands.b03[i] + bands.b11[i];
    const ndbiDen = bands.b11[i] + bands.b08[i];
    ndvi[i] = ndviDen === 0 ? 0 : (bands.b08[i] - bands.b04[i]) / ndviDen;
    mndwi[i] = mndwiDen === 0 ? 0 : (bands.b03[i] - bands.b11[i]) / mndwiDen;
    ndbi[i] = ndbiDen === 0 ? 0 : (bands.b11[i] - bands.b08[i]) / ndbiDen;
  }
  return { ndvi, mndwi, ndbi };
}
