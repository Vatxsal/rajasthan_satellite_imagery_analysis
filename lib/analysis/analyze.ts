/**
 * Change-detection orchestration: fetch A ∥ fetch B → process.
 *
 * Only the network half lives here (Sentinel Hub rasters, progress stages);
 * the pure classification pipeline moved to ./process in Phase 4 so the
 * validation harness can run the exact production code on synthetic inputs.
 *
 * Phase 5: both sides fetch in parallel (they are independent renders) while
 * stages still report A → B in order — the furthest step known to be done.
 * Both parsed sides stay alive for co-registration either way; overlapping the
 * two TIFF decodes costs some peak RSS (measured ~2.4 GB vs ~1.5 GB at the
 * 1500 px cap) and buys back roughly a full render latency (~135 s → ~90 s).
 *
 * Engine v1 fetches each date's single UTC day (server-side indices).
 * Engine v2 fetches a ±window median composite per side (12-band raw
 * reflectance + QC + recent-orbit indices).
 */
import { getServerEnv } from "@/lib/env";
import type { BBox } from "@/lib/data";
import { fetchCompareCompositeRaster, fetchCompareRaster } from "./fetch";
import { parseCompareRaster, parseCompositeRaster, toIndexRasters, type ParsedCompositeRaster } from "./parse";
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

/** Attaches a no-op handler so a fast failure cannot go unhandled while the
 *  other side is still being awaited (the rejection is rethrown on await). */
const swallow = (): void => undefined;

export async function runCompare(
  input: RunCompareInput,
  onStage?: (stage: CompareStage) => void,
): Promise<CompareArtifact> {
  const prep = prepareCompare(input, { puLimit: getServerEnv().PER_ANALYSIS_PU_LIMIT });
  const { bbox, width, height, windowDays, engine } = prep;

  async function fetchCompositeSide(
    date: string,
    otherDate: string,
    gridBox: BBox,
  ): Promise<ParsedCompositeRaster> {
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

  async function fetchSingleSide(date: string, gridBox: BBox): Promise<CompareSide> {
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

  onStage?.("fetch-a");
  const inputs: RasterInputs = {};
  if (engine === "v2") {
    const pa = fetchCompositeSide(input.dateA, input.dateB, bbox);
    const pb = fetchCompositeSide(input.dateB, input.dateA, bbox);
    void pb.then(swallow, swallow);
    inputs.parsedA = await pa;
    onStage?.("fetch-b");
    inputs.parsedB = await pb;
  } else {
    const sa = fetchSingleSide(input.dateA, bbox);
    const sb = fetchSingleSide(input.dateB, bbox);
    void sb.then(swallow, swallow);
    inputs.sideA = await sa;
    onStage?.("fetch-b");
    inputs.sideB = await sb;
  }

  onStage?.("analyze");
  return processCompare(input, inputs);
}
