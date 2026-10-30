/**
 * Change-detection orchestration: fetch A → fetch B → process.
 *
 * Only the network half lives here (Sentinel Hub rasters, progress stages);
 * the pure classification pipeline moved to ./process in Phase 4 so the
 * validation harness can run the exact production code on synthetic inputs.
 *
 * Engine v1 fetches each date's single UTC day (server-side indices).
 * Engine v2 fetches a ±window median composite per side (12-band raw
 * reflectance + QC + recent-orbit indices).
 */
import { fetchCompareCompositeRaster, fetchCompareRaster } from "./fetch";
import { parseCompareRaster, parseCompositeRaster, toIndexRasters, type ParsedCompositeRaster } from "./parse";
import type { BBox } from "@/lib/data";
import {
  prepareCompare,
  processCompare,
  type CompareArtifact,
  type CompareStage,
  type CompareSide,
  type RasterInputs,
  type RunCompareInput,
} from "./process";

export type {
  CompareArtifact,
  CompareStage,
  CompareZone,
  CompareSide,
  RasterInputs,
  RunCompareInput,
} from "./process";
export { prepareCompare, processCompare } from "./process";

export async function runCompare(
  input: RunCompareInput,
  onStage?: (stage: CompareStage) => void,
): Promise<CompareArtifact> {
  const prep = prepareCompare(input);
  const { bbox, width, height, windowDays, engine } = prep;

  async function fetchCompositeSide(
    stage: CompareStage,
    date: string,
    otherDate: string,
    gridBox: BBox,
  ): Promise<ParsedCompositeRaster> {
    onStage?.(stage);
    let buffer: Buffer | null = await fetchCompareCompositeRaster(
      input.geometry,
      date,
      gridBox,
      { width, height },
      windowDays,
      otherDate,
    );
    const parsed = await parseCompositeRaster(buffer);
    buffer = null;
    return parsed;
  }

  async function fetchSingleSide(
    stage: CompareStage,
    date: string,
    gridBox: BBox,
  ): Promise<CompareSide> {
    onStage?.(stage);
    let buffer: Buffer | null = await fetchCompareRaster(
      input.geometry,
      date,
      gridBox,
      { width, height },
    );
    const parsed = await parseCompareRaster(buffer);
    buffer = null;
    return { indices: toIndexRasters(parsed), valid: parsed.valid, width: parsed.width, height: parsed.height };
  }

  const inputs: RasterInputs = {};
  if (engine === "v2") {
    inputs.parsedA = await fetchCompositeSide("fetch-a", input.dateA, input.dateB, bbox);
    inputs.parsedB = await fetchCompositeSide("fetch-b", input.dateB, input.dateA, bbox);
  } else {
    inputs.sideA = await fetchSingleSide("fetch-a", input.dateA, bbox);
    inputs.sideB = await fetchSingleSide("fetch-b", input.dateB, bbox);
  }

  onStage?.("analyze");
  return processCompare(input, inputs);
}
