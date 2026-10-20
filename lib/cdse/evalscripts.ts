import type { CompositeId } from "@/lib/data";

/**
 * Sentinel Hub evalscripts (version 3) — same band recipes as Copernicus
 * Browser / EO Browser, used by BOTH /api/imagery (full-res downloads) and
 * /api/tiles (native-resolution XYZ tiles).
 *
 * Official EO Browser scripts:
 *  - True colour:  https://custom-scripts.sentinel-hub.com/sentinel-2/true_color/
 *                  (B04/B03/B02 with 2.5 gain, mosaicking ORBIT)
 *  - False colour: https://custom-scripts.sentinel-hub.com/sentinel-2/false_color/
 *                  (B08/B04/B03 vegetation false colour)
 *  - NDVI:         https://custom-scripts.sentinel-hub.com/sentinel-2/ndvi/
 *                  (EO Browser NDVI colour ramp, -0.2 … 1.0)
 *
 * mosaicking: "ORBIT" merges every tile of the requested UTC day (the Process
 * request passes mosaickingOrder "mostRecent") and dataMask-driven alpha makes
 * pixels outside coverage / outside the clip polygon transparent.
 */

const HEADER = "//VERSION=3\n";

const TRUE_COLOR = `${HEADER}function setup() {
  return {
    input: [{ bands: ["B04", "B03", "B02", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 4, sampleType: "AUTO" },
  };
}
function evaluatePixel(samples) {
  // samples = tiles of the day (most recent first); pick first with data.
  for (const s of samples) {
    if (s.dataMask === 1) return [s.B04 * 2.5, s.B03 * 2.5, s.B02 * 2.5, 1];
  }
  return [0, 0, 0, 0];
}`;

const FALSE_COLOR = `${HEADER}function setup() {
  return {
    input: [{ bands: ["B08", "B04", "B03", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 4, sampleType: "AUTO" },
  };
}
function evaluatePixel(samples) {
  for (const s of samples) {
    if (s.dataMask === 1) return [s.B08 * 2.5, s.B04 * 2.5, s.B03 * 2.5, 1];
  }
  return [0, 0, 0, 0];
}`;

/**
 * EO Browser NDVI colour ramp [value, [r, g, b] 0-1]. Shared with the UI
 * legend (components/map/NdviLegend.tsx) so the bar always matches the pixels.
 */
export const NDVI_RAMP: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [-0.2, [0.49, 0.3, 0.16]],
  [0.0, [0.72, 0.55, 0.3]],
  [0.25, [0.9, 0.82, 0.4]],
  [0.5, [0.6, 0.78, 0.3]],
  [0.75, [0.25, 0.6, 0.2]],
  [1.0, [0.08, 0.38, 0.12]],
];

function rampLiteral(): string {
  return `[${NDVI_RAMP.map(([v, c]) => `[${v}, [${c.join(", ")}]]`).join(", ")}]`;
}

const NDVI = `${HEADER}function setup() {
  return {
    input: [{ bands: ["B08", "B04", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 4, sampleType: "AUTO" },
  };
}
var ramp = ${rampLiteral()};
function rampColor(v) {
  if (v <= ramp[0][0]) return ramp[0][1];
  for (var i = 1; i < ramp.length; i++) {
    if (v <= ramp[i][0]) {
      var lo = ramp[i - 1];
      var hi = ramp[i];
      var t = (v - lo[0]) / (hi[0] - lo[0]);
      return [
        lo[1][0] + t * (hi[1][0] - lo[1][0]),
        lo[1][1] + t * (hi[1][1] - lo[1][1]),
        lo[1][2] + t * (hi[1][2] - lo[1][2]),
      ];
    }
  }
  return ramp[ramp.length - 1][1];
}
function evaluatePixel(samples) {
  for (const s of samples) {
    if (s.dataMask === 1) {
      var ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
      var c = rampColor(ndvi);
      return [c[0], c[1], c[2], 1];
    }
  }
  return [0, 0, 0, 0];
}`;

const SCRIPTS: Record<CompositeId, string> = {
  "true-color": TRUE_COLOR,
  "false-color": FALSE_COLOR,
  ndvi: NDVI,
};

export function evalscriptFor(composite: CompositeId): string {
  return SCRIPTS[composite] ?? TRUE_COLOR;
}

// ---------------------------------------------------- full-res download variants

const DL_HEADER = "//VERSION=3\n";

/**
 * Band order of the analysis GeoTIFF — shared with the download filename,
 * the GeoTIFF band descriptions and the UI copy.
 */
export const ANALYSIS_BANDS = [
  "B02",
  "B03",
  "B04",
  "B08",
  "B11",
  "B12",
  "NDVI",
  "SCL",
] as const;

/** Human labels written into the GeoTIFF (GDAL band descriptions). */
export const ANALYSIS_BAND_DESCRIPTIONS: string[] = [
  "B02 blue reflectance 10m",
  "B03 green reflectance 10m",
  "B04 red reflectance 10m",
  "B08 NIR reflectance 10m",
  "B11 SWIR1 reflectance 20m",
  "B12 SWIR2 reflectance 20m",
  "NDVI (B08-B04)/(B08+B04)",
  "SCL scene classification 0-11",
];

/** Value written everywhere outside the clip polygon / where no data exists. */
export const ANALYSIS_NODATA = "-9999";

/**
 * GeoTIFF download evalscripts (native 10 m):
 *  - "tiff"     → VISUAL: 8-bit RGB (display-stretched B04/B03/B02) for
 *                 viewing in QGIS / ArcGIS / a browser. Outside the polygon the
 *                 alpha band is 0 (falling back to nodata 0), so the area shape
 *                 survives the export.
 *  - "analysis" → ANALYSIS: FLOAT32, bands 1-6 = BOA reflectance 0-1,
 *                 band 7 = NDVI, band 8 = SCL, nodata -9999.
 * PNG downloads reuse the display evalscripts above (8-bit RGBA).
 */
const VISUAL_TIFF = `${DL_HEADER}function setup() {
  return {
    input: [{ bands: ["B04", "B03", "B02", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 4, sampleType: "UINT8" },
  };
}
function evaluatePixel(samples) {
  // sampleType UINT8 means the returned values are DN 0-255, so the 2.5
  // display gain has to be scaled (and saturated) into that range here.
  function dn(v) {
    v = v * 2.5 * 255;
    return v > 255 ? 255 : v;
  }
  for (const s of samples) {
    if (s.dataMask === 1) return [dn(s.B04), dn(s.B03), dn(s.B02), 255];
  }
  return [0, 0, 0, 0];
}`;

const ANALYSIS_TIFF = `${DL_HEADER}function setup() {
  return {
    input: [{ bands: ["B02", "B03", "B04", "B08", "B11", "B12", "SCL", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 8, sampleType: "FLOAT32" },
  };
}
function evaluatePixel(samples) {
  for (const s of samples) {
    if (s.dataMask === 1) {
      var denom = s.B08 + s.B04;
      var ndvi = denom === 0 ? -9999 : (s.B08 - s.B04) / denom;
      return [s.B02, s.B03, s.B04, s.B08, s.B11, s.B12, ndvi, s.SCL];
    }
  }
  return [-9999, -9999, -9999, -9999, -9999, -9999, -9999, -9999];
}`;

/** Evalscript for /api/imagery downloads (PNG = display script, TIFF = above). */
export function evalscriptForDownload(
  composite: CompositeId,
  format: "png" | "tiff" | "analysis",
): string {
  if (format === "analysis") return ANALYSIS_TIFF;
  if (format === "tiff") return VISUAL_TIFF;
  return evalscriptFor(composite);
}
