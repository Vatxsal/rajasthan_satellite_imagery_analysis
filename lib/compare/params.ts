/**
 * Analysis-parameter helpers shared by every client that talks to the
 * cache-backed compare routes (events / overlay / summary export).
 *
 * The server derives the cache key from exactly these fields — sending them
 * lets a cold cache recompute statelessly instead of answering 404 "expired"
 * (the client still holds stats + markers, so the server must be able to
 * rebuild its own copy). Values come from CompareMetadata, which echoes the
 * normalised inputs the key was built from.
 */
import type { CompareMetadata } from "@/lib/analysis/types";
import type { CompareSpeckle, Sensitivity, ThresholdOverrides } from "@/lib/analysis/config";

export interface AnalysisParams {
  areaId: string;
  level: "district" | "tehsil" | "ilr";
  dateA: string;
  dateB: string;
  sensitivity: Sensitivity;
  minPatchHa: number;
  inputMode: "single" | "composite";
  compositeWindowDays: number;
  /** Phase 2 despeckle mode (omitted by pre-Phase-2 callers → server default). */
  speckle?: CompareSpeckle;
  /** Phase 3 detail mode (omitted for quick runs — keeps quick keys/query
   *  byte-identical to pre-Phase-3 callers). */
  detail?: "quick" | "detailed" | "smart";
  /** Phase-thresholds: Custom-run overrides (omitted for preset runs). */
  thresholds?: ThresholdOverrides;
}

export function analysisParamsFromMetadata(metadata: CompareMetadata): AnalysisParams {
  return {
    areaId: metadata.areaId,
    level: metadata.areaLevel,
    dateA: metadata.dateA,
    dateB: metadata.dateB,
    sensitivity: metadata.sensitivity,
    minPatchHa: metadata.minPatchHa,
    inputMode: metadata.inputMode,
    compositeWindowDays: metadata.compositeWindowDays,
    ...(metadata.speckle ? { speckle: metadata.speckle } : {}),
    ...(metadata.detail ? { detail: metadata.detail } : {}),
    ...(metadata.thresholdOverrides && Object.keys(metadata.thresholdOverrides).length > 0
      ? { thresholds: metadata.thresholdOverrides }
      : {}),
  };
}

/**
 * Serialises the canonical parameter set — the ONE query shape the client
 * (analysisParamsQuery) and the server (compareParamsQueryString) both emit,
 * so a cache key derived from either side is byte-identical.
 */
export function paramsToQuery(params: AnalysisParams): URLSearchParams {
  const query = new URLSearchParams();
  query.set("areaId", params.areaId);
  query.set("level", params.level);
  query.set("dateA", params.dateA);
  query.set("dateB", params.dateB);
  query.set("sensitivity", params.sensitivity);
  query.set("minPatchHa", String(params.minPatchHa));
  query.set("inputMode", params.inputMode);
  query.set("compositeWindowDays", String(params.compositeWindowDays));
  if (params.speckle) query.set("speckle", params.speckle);
  if (params.detail && params.detail !== "quick") query.set("detail", params.detail);
  if (params.thresholds && Object.keys(params.thresholds).length > 0) {
    // One JSON-encoded param keeps the URL readable and the key stable; the
    // GET routes decode it before the canonical schema validates + clamps.
    query.set("thresholds", JSON.stringify(params.thresholds));
  }
  return query;
}

/** Query-string form for GET routes (events, overlay). */
export function analysisParamsQuery(metadata: CompareMetadata): URLSearchParams {
  return paramsToQuery(analysisParamsFromMetadata(metadata));
}
