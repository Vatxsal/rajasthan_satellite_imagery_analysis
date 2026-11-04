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

export interface AnalysisParams {
  areaId: string;
  level: "district" | "tehsil" | "ilr";
  dateA: string;
  dateB: string;
  sensitivity: "low" | "medium" | "high";
  minPatchHa: number;
  inputMode: "single" | "composite";
  compositeWindowDays: number;
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
  return query;
}

/** Query-string form for GET routes (events, overlay). */
export function analysisParamsQuery(metadata: CompareMetadata): URLSearchParams {
  return paramsToQuery(analysisParamsFromMetadata(metadata));
}
