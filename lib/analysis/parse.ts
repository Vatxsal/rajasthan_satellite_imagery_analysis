/**
 * GeoTIFF → numeric grids + the analysis grid geometry.
 * The Process API renders the request bbox linearly in EPSG:4326, so pixel
 * centres are exact linear interpolations of the bbox — no georeferencing
 * maths beyond the grid constants.
 */
import { fromArrayBuffer } from "geotiff";
import type { IndexRasters } from "./types";

export interface ParsedCompareRaster {
  width: number;
  height: number;
  ndvi: Float32Array;
  mndwi: Float32Array;
  ndbi: Float32Array;
  /** 1 = both SCL and dataMask passed (before combining across dates). */
  valid: Uint8Array;
}

/** Parses the 5-band FLOAT32 GeoTIFF into typed arrays. */
export async function parseCompareRaster(buffer: Buffer): Promise<ParsedCompareRaster> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = (await image.readRasters({
    width,
    height,
    samples: [0, 1, 2, 3, 4],
  })) as Float32Array[];

  const ndvi = bands[0];
  const mndwi = bands[1];
  const ndbi = bands[2];
  const validBand = bands[3];
  const dataMask = bands[4];

  const valid = new Uint8Array(width * height);
  for (let i = 0; i < valid.length; i++) {
    valid[i] = validBand[i] >= 0.5 && dataMask[i] >= 0.5 ? 1 : 0;
  }

  return { width, height, ndvi, mndwi, ndbi, valid };
}

/** Extracts the index triple (shared with tests). */
export function toIndexRasters(parsed: ParsedCompareRaster): IndexRasters {
  return { ndvi: parsed.ndvi, mndwi: parsed.mndwi, ndbi: parsed.ndbi };
}

export interface ParsedNdviMonth {
  width: number;
  height: number;
  /** Median NDVI of the month's valid orbits (0 where VALID=0). */
  ndvi: Float32Array;
  /** 1 when ≥ 1 valid orbit contributed to the pixel. */
  valid: Uint8Array;
}

/** Parses the 2-band FLOAT32 monthly NDVI render (NDVI month median + VALID). */
export async function parseNdviMonthRaster(buffer: Buffer): Promise<ParsedNdviMonth> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = (await image.readRasters({
    width,
    height,
    samples: [0, 1],
  })) as Float32Array[];

  const ndvi = bands[0];
  const validBand = bands[1];
  const valid = new Uint8Array(width * height);
  for (let i = 0; i < valid.length; i++) {
    valid[i] = validBand[i] >= 0.5 ? 1 : 0;
  }

  return { width, height, ndvi, valid };
}

export interface ParsedCompositeRaster {
  width: number;
  height: number;
  b02: Float32Array;
  b03: Float32Array;
  b04: Float32Array;
  b05: Float32Array;
  b08: Float32Array;
  b11: Float32Array;
  b12: Float32Array;
  /** 1 where at least one valid orbit contributed to the median. */
  valid: Uint8Array;
  /** Number of valid orbits used per pixel (0 = nodata). */
  obsCount: Float32Array;
  /** SCL of the most recent valid orbit (diagnostics). */
  scl: Float32Array;
  /** Recent-orbit indices (most recent valid sample in the window) — Phase 2.7 persistence. */
  recentNdvi: Float32Array;
  recentMndwi: Float32Array;
  recentNdbi: Float32Array;
}

/** Parses the composite 12-band FLOAT32 GeoTIFF (median reflectances + QC + recent indices). */
export async function parseCompositeRaster(buffer: Buffer): Promise<ParsedCompositeRaster> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = (await image.readRasters({
    width,
    height,
    samples: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  })) as Float32Array[];

  const valid = new Uint8Array(width * height);
  const obsCount = bands[7];
  for (let i = 0; i < valid.length; i++) {
    valid[i] = obsCount[i] >= 1 ? 1 : 0;
  }

  return {
    width,
    height,
    b02: bands[0],
    b03: bands[1],
    b04: bands[2],
    b05: bands[3],
    b08: bands[4],
    b11: bands[5],
    b12: bands[6],
    valid,
    obsCount,
    scl: bands[8],
    recentNdvi: bands[9],
    recentMndwi: bands[10],
    recentNdbi: bands[11],
  };
}

export interface ParsedS1Side {
  width: number;
  height: number;
  /** Median VV backscatter in dB (NaN where invalid). */
  vvDb: Float32Array;
  /** Median VH backscatter in dB (NaN where invalid). */
  vhDb: Float32Array;
  /** Valid acquisitions contributing to the median (0 = nodata). */
  count: Float32Array;
  /** 1 where count ≥ 1. */
  valid: Uint8Array;
}

/** Parses the 3-band FLOAT32 S1 raster (median VV/VH linear power + count)
 *  and converts backscatter to dB. dB is monotonic, so dB(median(linear)) is
 *  the median of the dB series (up to even-sample averaging). */
export async function parseS1Side(buffer: Buffer): Promise<ParsedS1Side> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = (await image.readRasters({
    width,
    height,
    samples: [0, 1, 2],
  })) as Float32Array[];

  const vvLinear = bands[0];
  const vhLinear = bands[1];
  const count = bands[2];
  const n = width * height;
  const vvDb = new Float32Array(n);
  const vhDb = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (count[i] >= 1 && vvLinear[i] > 0 && vhLinear[i] > 0) {
      valid[i] = 1;
      vvDb[i] = (10 * Math.log(vvLinear[i])) / Math.LN10;
      vhDb[i] = (10 * Math.log(vhLinear[i])) / Math.LN10;
    } else {
      valid[i] = 0;
      vvDb[i] = NaN;
      vhDb[i] = NaN;
    }
  }
  return { width, height, vvDb, vhDb, count, valid };
}

/** Parses the single-band FLOAT32 elevation render (metres) from the DEM
 *  dataset (lib/analysis/terrain.ts). */
export async function parseElevationRaster(
  buffer: Buffer,
): Promise<{ width: number; height: number; elevation: Float32Array }> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = (await image.readRasters({
    width,
    height,
    samples: [0],
  })) as Float32Array[];
  return { width, height, elevation: bands[0] };
}
