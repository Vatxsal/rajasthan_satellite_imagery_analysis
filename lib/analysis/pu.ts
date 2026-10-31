/**
 * Phase 5 — processing-unit (PU) cost model for Copernicus Data Space
 * Ecosystem Process renders (audit §5, formula verified against the CDSE
 * "Processing Unit" docs and the Sentinel Hub FAQ):
 *
 *   PU = (W×H / 512², min 0.01)
 *      × (input bands / 3, dataMask not counted)
 *      × (2 if the response is a 32-bit float TIFF, else 1)
 *      × data samples per pixel (ORBIT observations inside the time range)
 *      × surcharges (orthorectification, data fusion, …)
 *   min cost per Process request = 0.005 PU
 *
 * Pure arithmetic — the PER_ANALYSIS_PU_LIMIT comparison lives in
 * prepareCompare (lib/analysis/process.ts), so this module stays importable
 * from the node test harness with no env dependency.
 */

/** Input bands counted by the formula (dataMask is not counted). */
export const V1_INPUT_BANDS = 5; // B03 B04 B08 B11 SCL (evalscript.ts:18)
export const V2_INPUT_BANDS = 9; // B02 B03 B04 B05 B08 B11 B12 SCL CLD (evalscript.ts:65)

const TILE_PX = 512;
const MIN_SIZE_FACTOR = 0.01;
const MIN_RENDER_PU = 0.005;

export interface RenderPuInput {
  width: number;
  height: number;
  inputBands: number;
  /** True when the Process response is a 32-bit float TIFF (both engines). */
  float: boolean;
  /** Data samples per pixel = ORBIT observations inside the time range. */
  samples: number;
}

/** Estimated PU of one Process render. */
export function estimateRenderPu(r: RenderPuInput): number {
  const size = Math.max((r.width * r.height) / (TILE_PX * TILE_PX), MIN_SIZE_FACTOR);
  const pu =
    size *
    (Math.max(1, r.inputBands) / 3) *
    (r.float ? 2 : 1) *
    Math.max(1, Math.round(r.samples));
  return Math.max(pu, MIN_RENDER_PU);
}

/** An analysis is two Process renders (side A + side B). */
export function estimateAnalysisPu(r: RenderPuInput): number {
  return estimateRenderPu(r) * 2;
}

/**
 * ORBIT samples counted per pixel for a ±windowDays composite: Rajasthan gets
 * S2A+S2B ≈ 5-day revisit, so ≈ 2·window/5 observations per side (audit §5 —
 * ±7 d → 3 samples, window 0 / v1 → 1, ±15 d → 6).
 */
export function compositeSamples(windowDays: number): number {
  return Math.max(1, Math.round((windowDays * 2) / 5));
}
