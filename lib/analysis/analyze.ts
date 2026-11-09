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
import { parseCompareRaster, parseCompositeRaster, parseElevationRaster, toIndexRasters, type ParsedCompositeRaster } from "./parse";
import {
  prepareCompare,
  processCompare,
  type CompareArtifact,
  type CompareStage,
  type CompareSide,
  type EvidenceInputs,
  type RasterInputs,
  type RunCompareInput,
} from "./process";
import { defaultS1Deps, fetchS1Pair, sarFeatures } from "./s1";
import { defaultWorldCoverDeps, fetchWorldCoverPrior } from "./prior";
import { computeTerrain, fetchElevationRaster } from "./terrain";

export type {
  CompareArtifact,
  CompareStage,
  CompareZone,
  CompareSide,
  EvidenceInputs,
  RasterInputs,
  RunCompareInput,
} from "./process";
export { prepareCompare, processCompare } from "./process";

/** Attaches a no-op handler so a fast failure cannot go unhandled while the
 *  other side is still being awaited (the rejection is rethrown on await). */
const swallow = (): void => undefined;

/**
 * Phase 3 — fused evidence fetch: S1 pair, WorldCover prior and DEM terrain
 * in parallel, each failing gracefully to "off" (null). Started BEFORE the
 * optical fetches so the extra renders/COG reads overlap them; awaited after
 * both sides are in.
 */
async function fetchFusedEvidence(
  input: RunCompareInput,
  prep: ReturnType<typeof prepareCompare>,
): Promise<EvidenceInputs> {
  const env = getServerEnv();
  const { bbox, grid, width, height } = prep;
  const size = { width, height };
  const plan = input.evidencePlan;
  const s1WindowDays = plan?.s1WindowDays ?? null;

  const s1Task =
    s1WindowDays != null && s1WindowDays > 0
      ? fetchS1Pair(
          { dateA: input.dateA, dateB: input.dateB },
          defaultS1Deps(input.geometry, s1WindowDays, size),
        ).catch((error: unknown) => ({
          ok: false as const,
          reason: "fetch-failed" as const,
          detail: String(error),
        }))
      : Promise.resolve(null);
  const priorTask = env.WORLDCOVER_ENABLED
    ? defaultWorldCoverDeps()
        .then((deps) =>
          fetchWorldCoverPrior(
            { bbox, width, height, pxLon: grid.pxLon, pxLat: grid.pxLat },
            deps,
          ),
        )
        .catch(() => null)
    : Promise.resolve(null);
  const terrainTask = plan?.terrain
    ? (async () => {
        const render = await fetchElevationRaster(input.geometry, size);
        if (!render) return null;
        const { elevation } = await parseElevationRaster(render.buffer);
        return { grids: computeTerrain(elevation, grid), demInstance: render.demInstance };
      })().catch(() => null)
    : Promise.resolve(null);

  const [s1, prior, terrain] = await Promise.all([s1Task, priorTask, terrainTask]);
  const out: EvidenceInputs = {};
  if (s1 && s1.ok) {
    out.sar = sarFeatures(s1.a, s1.b);
    out.s1 = { orbit: s1.orbit };
    out.s1WindowDays = s1WindowDays;
  } else {
    out.s1 = { skipped: s1 ? s1.reason : "disabled" };
  }
  if (prior) out.prior = prior;
  if (terrain) {
    out.terrain = terrain.grids;
    out.demInstance = terrain.demInstance;
  }
  return out;
}

export async function runCompare(
  input: RunCompareInput,
  onStage?: (stage: CompareStage) => void,
): Promise<CompareArtifact> {
  const prep = prepareCompare(input, { puLimit: getServerEnv().PER_ANALYSIS_PU_LIMIT });
  const { bbox, width, height, windowDays, engine } = prep;
  // Fused and ML rules both consume the Phase 3 evidence streams.
  const evidenceOn = (input.rules === "fused" || input.rules === "ml") && engine === "v2";
  // Kick off before the optical renders so evidence latency hides underneath.
  const evidenceTask = evidenceOn
    ? fetchFusedEvidence(input, prep)
    : Promise.resolve<EvidenceInputs>({});

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
  const evidence = await evidenceTask;
  return processCompare(input, inputs, evidence);
}
