/**
 * Draw & analyze — pixel statistics over one analysis render of a shape.
 *
 * The analysis GeoTIFF (lib/cdse/evalscripts.ts ANALYSIS_TIFF) is clipped to
 * the shape: everything outside it (and any missing observation) is nodata.
 * NDVI stats are computed over CLEAR pixels only (SCL not cloud/shadow/cirrus)
 * so a cloudy scene never drags the vegetation signal down; the SCL shares
 * still count clouds — "12% cloudy" is exactly what the user needs to judge
 * the result. Pure arithmetic: no I/O, unit-tested with synthetic rasters.
 */

/** Nodata stamp of the analysis evalscript (-9999). */
export const SHAPE_NODATA = -9999;
/** SCL classes that count as cloudy/snowy (mirror of the sample route). */
const CLOUDY_SCL = new Set([3, 8, 9, 10]);

/** SCL class → display group. 7 = "unclassified" reads as built/other here. */
const SCL_GROUP: Record<number, keyof ShapeSclShares> = {
  4: "vegetation",
  5: "bare",
  6: "water",
  7: "built",
  1: "built",
  2: "built",
  3: "shadow",
  8: "cloud",
  9: "cloud",
  10: "cloud",
  11: "other",
};

export interface ShapeNdviStats {
  /** Clear pixels with valid NDVI. */
  count: number;
  mean: number;
  median: number;
  std: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
}

/** Percentage of VALID pixels (0-100, one decimal) per land/cover group. */
export interface ShapeSclShares {
  vegetation: number;
  bare: number;
  water: number;
  built: number;
  cloud: number;
  shadow: number;
  other: number;
}

export interface ShapePixelStats {
  /** width × height of the render grid (bbox-covering). */
  total: number;
  /** Pixels inside the shape with an observation (incl. cloudy). */
  valid: number;
  /** Valid pixels that are clear (NDVI stats source). */
  clear: number;
  /** Valid pixels classified cloud/shadow/cirrus/snow. */
  cloudy: number;
  /** Pixels outside the shape / no observation. */
  nodata: number;
}

export interface ShapeStats {
  pixels: ShapePixelStats;
  /** Null when no clear pixel exists in the scene. */
  ndvi: ShapeNdviStats | null;
  /** Null when no valid pixel exists. */
  scl: ShapeSclShares | null;
}

function isValid(ndvi: number): boolean {
  return Number.isFinite(ndvi) && ndvi > SHAPE_NODATA + 1;
}

/** Linear-interpolation percentile (numpy default, type 7) over a sorted copy. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const index = p * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * NDVI + SCL statistics for one rendered shape.
 * `ndvi` and `scl` are the flat raster bands (band 7 / band 8 of the analysis
 * GeoTIFF), same length, row-major.
 */
export function computeShapeStats(
  ndvi: ArrayLike<number>,
  scl: ArrayLike<number>,
): ShapeStats {
  const total = ndvi.length;
  let valid = 0;
  let cloudy = 0;
  const clearNdvi: number[] = [];
  const groupCounts: Record<keyof ShapeSclShares, number> = {
    vegetation: 0,
    bare: 0,
    water: 0,
    built: 0,
    cloud: 0,
    shadow: 0,
    other: 0,
  };

  for (let i = 0; i < total; i++) {
    const ndviValue = ndvi[i] ?? SHAPE_NODATA;
    if (!isValid(ndviValue)) continue;
    valid += 1;

    const code = Math.round(scl[i] ?? 0);
    const group = SCL_GROUP[code] ?? "other";
    groupCounts[group] += 1;
    if (CLOUDY_SCL.has(code)) {
      cloudy += 1;
      continue;
    }
    clearNdvi.push(ndviValue);
  }

  const pixels: ShapePixelStats = {
    total,
    valid,
    clear: clearNdvi.length,
    cloudy,
    nodata: total - valid,
  };

  let shares: ShapeSclShares | null = null;
  if (valid > 0) {
    const pct = (count: number): number => round((count / valid) * 100, 1);
    shares = {
      vegetation: pct(groupCounts.vegetation),
      bare: pct(groupCounts.bare),
      water: pct(groupCounts.water),
      built: pct(groupCounts.built),
      cloud: pct(groupCounts.cloud),
      shadow: pct(groupCounts.shadow),
      other: pct(groupCounts.other),
    };
  }

  let ndviStats: ShapeNdviStats | null = null;
  if (clearNdvi.length > 0) {
    const sorted = [...clearNdvi].sort((a, b) => a - b);
    const count = clearNdvi.length;
    const mean = clearNdvi.reduce((sum, value) => sum + value, 0) / count;
    const variance =
      clearNdvi.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
    ndviStats = {
      count,
      mean: round(mean, 4),
      median: round(percentile(sorted, 0.5), 4),
      std: round(Math.sqrt(variance), 4),
      min: round(sorted[0]!, 4),
      max: round(sorted[count - 1]!, 4),
      p25: round(percentile(sorted, 0.25), 4),
      p75: round(percentile(sorted, 0.75), 4),
    };
  }

  return { pixels, ndvi: ndviStats, scl: shares };
}
