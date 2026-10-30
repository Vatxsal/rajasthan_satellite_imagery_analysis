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
}

/** Parses the composite 9-band FLOAT32 GeoTIFF (median reflectances + QC). */
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
    samples: [0, 1, 2, 3, 4, 5, 6, 7, 8],
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
  };
}
