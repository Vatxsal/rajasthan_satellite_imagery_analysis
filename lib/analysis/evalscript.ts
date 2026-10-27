/**
 * Evalscript for change analysis: 5-band FLOAT32 raster (ORBIT mosaicking,
 * L2A) per date. Indices are computed on the server so both dates come back
 * as plain numerics — no 8-bit quantisation of difference signals.
 *
 * Bands: 1 NDVI · 2 MNDWI · 3 NDBI · 4 VALID (SCL) · 5 dataMask.
 * Nodata → 0 in every band; VALID=0 distinguishes "no data" from real 0s.
 */
const HEADER = "//VERSION=3\n";

/** SCL classes excluded from VALID (mirrors config.ts EXCLUDED_SCL). */
const EXCLUDED_SCL = [0, 1, 3, 8, 9, 10, 11];

export const COMPARE_EVALSCRIPT = `${HEADER}function setup() {
  return {
    input: [{ bands: ["B03", "B04", "B08", "B11", "SCL", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 5, sampleType: "FLOAT32" },
  };
}
var excluded = ${JSON.stringify(EXCLUDED_SCL)};
function isValid(scl) {
  for (var i = 0; i < excluded.length; i++) {
    if (scl === excluded[i]) return 0;
  }
  return 1;
}
function evaluatePixel(samples) {
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (s.dataMask === 1) {
      var ndviDen = s.B08 + s.B04;
      var mndwiDen = s.B03 + s.B11;
      var ndbiDen = s.B11 + s.B08;
      var ndvi = ndviDen === 0 ? 0 : (s.B08 - s.B04) / ndviDen;
      var mndwi = mndwiDen === 0 ? 0 : (s.B03 - s.B11) / mndwiDen;
      var ndbi = ndbiDen === 0 ? 0 : (s.B11 - s.B08) / ndbiDen;
      return [ndvi, mndwi, ndbi, isValid(s.SCL), 1];
    }
  }
  return [0, 0, 0, 0, 0];
}`;
