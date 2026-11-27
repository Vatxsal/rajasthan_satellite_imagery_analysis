/**
 * Change-detection processing pipeline — pure maths, no network, no env.
 *
 * Split out of analyze.ts (Phase 4) so the exact production pipeline (v1 and
 * v2 classification, denoise, MMU, stats, overlay) can be driven by synthetic
 * A/B rasters inside the validation harness (validation/scenarios.ts) without
 * touching Sentinel Hub. analyze.ts keeps only fetch orchestration.
 *
 * Engine v1 consumes each date's parsed index rasters (single UTC day).
 * Engine v2 consumes the Phase 2 composite inputs and runs co-registration
 * (2.2) → radiometric normalisation (2.1) → extended index stack (2.3) →
 * adaptive thresholds (2.4) → multi-index vote with CVA, sub-labels,
 * persistence and confidence tiers (2.5-2.8). Everything from the majority
 * filter onwards is shared.
 */
import { deflateSync } from "node:zlib";
import {
  assertProcessOutputSize,
  bboxFromGeometry,
  computeOutputSize,
  PROCESS_MAX_OUTPUT_PX,
  type ClipGeometry,
} from "../cdse/geometry";
import type { BBox } from "@/lib/data";
import {
  CLASS,
  COMPOSITE_ERODE_RADIUS,
  COMPOSITE_WINDOW_DAYS_DEFAULT,
  COMPOSITE_WINDOW_DAYS_MAX,
  DEFAULT_MAX_PX,
  DEFAULT_MIN_PATCH_HA,
  GRID_MIN_PX,
  M2_PER_HA,
  V2_SHORT_GAP_DAYS,
  applyThresholdOverrides,
  hasThresholdOverrides,
  scaledThresholds,
  seasonalTag,
  type CompareRules,
  type CompareSpeckle,
  type ScaledThresholds,
  type Sensitivity,
  type ThresholdOverrides,
} from "./config";
import { combineValidity, classifyChange, dilateInvalid } from "./classify";
import {
  compositeSideFlags,
  computeCoverage,
  countClasses,
  coverageReasonRaster,
  deltaHistogram,
  edgeEventMask,
  edgeProximityMask,
  histogramThresholds,
  magnitudePlanes,
  patchDiagnostics,
  singleSideFlags,
  type CompareDiagnostics,
  type MagnitudePlanes,
} from "./diagnostics";
import type { GapFillInfo } from "./gapfill";
import { applyShapeEvidence, classifyFused } from "./fused";
import { classifyModel, loadMlModel } from "./model";
import {
  fillSmallHoles,
  gentleDespeckle,
  labelPatches,
  majorityFilter,
  magnitudeGrid,
  minPatchPixels,
} from "./filter";
import { makeAnalysisGrid, nativeLongSidePx } from "./grid";
import { erodeMask, rasterizeAreaMask, rasterizeZones } from "./mask";
import { classToRgba, encodePng } from "./png";
import type { ParsedCompositeRaster } from "./parse";
import {
  DEM_INPUT_BANDS,
  S1_INPUT_BANDS,
  V1_INPUT_BANDS,
  V2_INPUT_BANDS,
  compositeSamples,
  estimateAnalysisPu,
  estimateRenderPu,
  s1Samples,
} from "./pu";
import type { SarFeatures } from "./s1";
import { sharpenSwir } from "./sharpen";
import type { WorldCoverPrior } from "./prior";
import type { TerrainGrids } from "./terrain";
import { buildPatchVectors, computeStats, type ZoneMeta } from "./stats";
import {
  adaptiveThresholds,
  applyShift,
  autoThresholds,
  classifyV2,
  deriveV2Indices,
  estimateShift,
  normalizeBands,
  scaleThresholds,
} from "./v2";
import type {
  CompareEngine,
  CompareInputMode,
  CompareStats,
  DateSceneMeta,
  EngineStats,
  EvidenceMeta,
  IndexRasters,
} from "./types";
import type { ClassifyV2Output, RecentIndices, V2Indices } from "./v2";

export type CompareStage = "fetch-a" | "fetch-b" | "rescue" | "analyze";

export interface CompareZone {
  id: string;
  name: string;
  geometry: ClipGeometry;
}

export interface RunCompareInput {
  geometry: ClipGeometry;
  dateA: string;
  dateB: string;
  areaName: string;
  areaLevel: "district" | "tehsil" | "ilr";
  /** Stable area id (from the bounds route) — mirrors CompareMetadata.areaId so
   *  cache-backed routes can rebuild this input and recompute statelessly. */
  areaId: string;
  sensitivity: Sensitivity;
  minPatchHa?: number;
  /** Phase 2 despeckle: gentle (default) = magnitude-aware component removal,
   *  legacy = the pre-Phase-2 3×3 majority passes. */
  speckle?: CompareSpeckle;
  /** Long-side cap of the analysis grid (COMPARE_MAX_PX). */
  maxPx?: number;
  /** Phase 3: exact output raster size — blocks (and smart screening) derive
   *  their grid from grid-aligned bboxes, so aspect rounding must not shift
   *  pixels off the AOI lattice. Overrides the maxPx/native computation. */
  outputSize?: { width: number; height: number };
  /** Phase 3: per-run PU budget override (0 disables the guard) — the smart
   *  screening pass is governed by the estimate/confirm card instead of the
   *  single-analysis cap. */
  puLimit?: number;
  /** Phase-thresholds: SSO per-run overrides (already clamped by the zod
   *  schema / applyThresholdOffsets). Any value present marks the run
   *  "Custom" and bypasses v2 adaptive scaling for deterministic results. */
  thresholds?: ThresholdOverrides | null;
  /** Phase-thresholds: capture the derived per-date index grids on the
   *  artifact (`derived`) so a thresholds-only re-run can re-classify with
   *  zero Process API calls (set by ensureCompare for whole-AOI runs). */
  captureDerived?: boolean;
  sceneA?: DateSceneMeta | null;
  sceneB?: DateSceneMeta | null;
  /** Tehsil polygons for the zonal breakdown (district level only). */
  zones?: CompareZone[] | null;
  /** Change engine (CHANGE_ENGINE env): v1 = single-date inputs, v2 = composite. */
  engine?: CompareEngine;
  /** v2 input mode: "single" = one UTC day per side, "composite" = ±window median. */
  inputMode?: CompareInputMode;
  /** v2 ±composite window in days (0-15). */
  compositeWindowDays?: number;
  /** Change-rule mode (CHANGE_RULES); default "legacy" keeps shipped rules. */
  rules?: CompareRules;
  /** SHARPEN_SWIR: regression-based B11/B12 sharpening before index
   *  derivation (v2 composite path only; cache-keyed — it changes NDBI/MNDWI/BSI). */
  sharpen?: boolean;
  /** PU budget for the fused evidence renders (S1 pair + DEM); null = off. */
  evidencePlan?: { s1WindowDays: number | null; terrain: boolean } | null;
}

/**
 * Phase 3 fused evidence injected into processCompare (fetched live in
 * analyze.ts, or synthetic in tests). Every stream degrades to null/off.
 */
export interface EvidenceInputs {
  sar?: SarFeatures | null;
  /** S1 outcome for the method card: orbit used, or the skip reason. */
  s1?: { orbit: string } | { skipped: string } | null;
  s1WindowDays?: number | null;
  prior?: WorldCoverPrior | null;
  terrain?: TerrainGrids | null;
  demInstance?: string | null;
}

export interface CompareArtifact {
  result: CompareStats;
  overlayPng: Buffer;
  /** Deflated raw class raster — stored for GeoTIFF export. */
  classGz: Buffer;
  /** Phase 1: deflated per-pixel coverage-reason raster (COVERAGE_REASON codes). */
  coverageGz: Buffer;
  /** Phase 1: deflated gap-fill source flags (1 = rescued from ±window). */
  sourceGz: Buffer;
  /** Phase 1: deflated int8 Δ-index magnitude planes (MAGNITUDE_SCALE). */
  magnitudeGz: { ndvi: Buffer; mndwi: Buffer; ndbi: Buffer; combined: Buffer };
  /** Classified raster (CLASS codes) — validation/events vectorize from this. */
  classGrid: Uint8Array;
  /** Kept-patch labels from labelPatches (0 = no kept patch). */
  labels: Int32Array;
  /** Full-coverage change patches, largest-first cap (Phase 5, #13). */
  patchVectors: GeoJSON.FeatureCollection;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  /** Phase 3: raw arrays behind the deflated planes + patch aux — the detail
   *  orchestrator computes core-scoped counts before these are dropped. */
  coverage: Uint8Array;
  source: Uint8Array;
  magnitude: MagnitudePlanes;
  edgeMask: Uint8Array | null;
  tiers: Uint8Array | null;
  /** Phase-thresholds: present on whole-AOI runs — the derived per-date
   *  grids for zero-PU threshold re-classification (consumed and dropped by
   *  ensureCompare; never stored in the cache entry artifacts). */
  derived?: DerivedIndexGrids;
}

/** One v1 side: parsed index rasters for a single UTC day. */
export interface CompareSide {
  indices: IndexRasters;
  valid: Uint8Array;
  /** dataMask = 0 flag — Phase 0 coverage breakdown ("missing" vs "cloud"). */
  nodata?: Uint8Array;
  width: number;
  height: number;
}

/** Parsed rasters injected into the pipeline (fetched live, or synthetic). */
export interface RasterInputs {
  /** v2 sides (composite mode). */
  parsedA?: ParsedCompositeRaster | null;
  parsedB?: ParsedCompositeRaster | null;
  /** v1 sides (single-date mode). */
  sideA?: CompareSide | null;
  sideB?: CompareSide | null;
  /** Phase 1 coverage rescue: merge marks + method-card statement (analyze.ts). */
  gapFill?: GapFillInfo | null;
}

export interface PreparedCompare {
  bbox: BBox;
  grid: ReturnType<typeof makeAnalysisGrid>;
  width: number;
  height: number;
  baseThresholds: ScaledThresholds;
  windowDays: number;
  gapDays: number;
  minPatchHa: number;
  engine: CompareEngine;
  inputMode: CompareInputMode;
  /** Estimated PU for both renders (cost model, audit §5). */
  estimatedPu: number;
}

export interface PrepareOptions {
  /** PER_ANALYSIS_PU_LIMIT (PU); ≤0 or omitted disables the guard. */
  puLimit?: number;
}

function dayGap(dateA: string, dateB: string): number {
  return Math.round((Date.parse(dateB) - Date.parse(dateA)) / 86_400_000);
}

/** Method-card evidence summary actually available to this run (Phase 3). */
function evidenceMeta(e: EvidenceInputs): EvidenceMeta {
  const s1 = e.s1 ?? null;
  return {
    s1,
    s1WindowDays: s1 && "orbit" in s1 ? (e.s1WindowDays ?? null) : null,
    worldCover: Boolean(e.prior),
    terrain: Boolean(e.terrain),
    demInstance: e.demInstance ?? null,
  };
}

/**
 * Pure setup: grid geometry, thresholds, engine/input-mode normalisation and
 * the composite window. Shared by the fetching path and processCompare (runs
 * twice there — trivial cost, single source of truth).
 */
export function prepareCompare(input: RunCompareInput, options: PrepareOptions = {}): PreparedCompare {
  const bbox = bboxFromGeometry(input.geometry);
  if (!bbox) {
    throw Object.assign(new Error("Geometry has no coordinates."), {
      status: 400,
      code: "INVALID_GEOMETRY",
    });
  }
  // #14: COMPARE_MAX_PX is a ceiling, not a target — never upscale a small
  // AOI past its native 10 m pixel grid (faster, cheaper, honest resolution).
  // The Process API refuses outputs above PROCESS_MAX_OUTPUT_PX per side, so
  // every analysis grid is clamped there regardless of the env setting.
  const maxPx = input.maxPx ?? DEFAULT_MAX_PX;
  const nativeCap = Math.max(
    GRID_MIN_PX,
    Math.min(maxPx, Math.floor(nativeLongSidePx(bbox)), PROCESS_MAX_OUTPUT_PX),
  );
  const { width, height } = input.outputSize ?? computeOutputSize(bbox, nativeCap);
  // Explicit grids (detail blocks / screening / probe windows) bypass the
  // cap above — validate them at the same last line as the fetch itself.
  assertProcessOutputSize(width, height);
  const grid = makeAnalysisGrid(bbox, width, height);
  const minPatchHa = input.minPatchHa ?? DEFAULT_MIN_PATCH_HA;
  // Phase-thresholds: preset values, then any SSO override (clamped) — a run
  // with overrides is "Custom" and skips v2 adaptive scaling downstream.
  const baseThresholds = applyThresholdOverrides(
    scaledThresholds(input.sensitivity),
    input.thresholds,
  );

  const engine: CompareEngine = input.engine ?? "v1";
  // v2 always reads raw bands (even in "single" mode: window 0 → one day).
  const inputMode: CompareInputMode = engine === "v2" ? (input.inputMode ?? "composite") : "single";
  const windowDays =
    inputMode === "composite"
      ? Math.min(
          Math.max(input.compositeWindowDays ?? COMPOSITE_WINDOW_DAYS_DEFAULT, 0),
          COMPOSITE_WINDOW_DAYS_MAX,
        )
      : 0;

  // #15: PU cost estimate + cap, before any network work.
  const inputBands = engine === "v2" ? V2_INPUT_BANDS : V1_INPUT_BANDS;
  const samples =
    engine === "v2" && inputMode === "composite" ? compositeSamples(windowDays) : 1;
  let estimatedPu =
    Math.round(
      estimateAnalysisPu({ width, height, inputBands, float: true, samples }) * 100,
    ) / 100;
  // Phase 3: fused evidence = two S1 renders (one per side; a DESC fallback
  // probe is the rare extra) + one DEM render. WorldCover is a free COG read.
  const plan = input.evidencePlan;
  if (plan) {
    const s1Pu =
      plan.s1WindowDays != null
        ? estimateRenderPu({
            width,
            height,
            inputBands: S1_INPUT_BANDS,
            float: true,
            samples: s1Samples(plan.s1WindowDays),
          }) * 2
        : 0;
    const demPu = plan.terrain
      ? estimateRenderPu({ width, height, inputBands: DEM_INPUT_BANDS, float: true, samples: 1 })
      : 0;
    estimatedPu = Math.round((estimatedPu + s1Pu + demPu) * 100) / 100;
  }
  const puLimit = options.puLimit ?? 0;
  if (puLimit > 0 && estimatedPu > puLimit) {
    throw Object.assign(
      new Error(
        `This analysis would cost about ${estimatedPu} PU, over the server cap of ${puLimit} PU. ` +
          `Pick a smaller area or a shorter composite window, or raise PER_ANALYSIS_PU_LIMIT.`,
      ),
      { status: 413, code: "PU_LIMIT_EXCEEDED" },
    );
  }

  return {
    bbox,
    grid,
    width,
    height,
    baseThresholds,
    windowDays,
    gapDays: dayGap(input.dateA, input.dateB),
    minPatchHa,
    engine,
    inputMode,
    estimatedPu,
  };
}

/**
 * Phase-thresholds: the derived per-date grids one analysis actually
 * classified from (post co-registration / normalisation / index derivation,
 * post gap-fill merge) plus the fused evidence grids and the small engine
 * stats needed to rebuild identical metadata. Cached per (area, dates,
 * grid, gap-fill settings) — WITHOUT thresholds — so a thresholds-only
 * re-run re-classifies with zero Process API calls.
 */
export interface DerivedIndexGrids {
  engine: CompareEngine;
  width: number;
  height: number;
  /** v2: the full derived index stack (classify reads ndmi/ndwi/bsi/awei/
   *  brightness/nbr too — 9 planes per side); v1: the NDVI/MNDWI/NDBI triple. */
  idxA: V2Indices | IndexRasters;
  idxB: V2Indices | IndexRasters;
  validA: Uint8Array;
  validB: Uint8Array;
  nodataA: Uint8Array | null;
  nodataB: Uint8Array | null;
  cloudyA: Uint8Array | null;
  cloudyB: Uint8Array | null;
  preCombined: Uint8Array;
  valid: Uint8Array;
  aRecent: RecentIndices | null;
  bRecent: RecentIndices | null;
  gapSource: Uint8Array;
  gapFillInfo: GapFillInfo | null;
  evidence: EvidenceInputs;
  engineMeta: {
    normalization: ReturnType<typeof normalizeBands> | null;
    coReg: ReturnType<typeof estimateShift> | null;
    sharpen: {
      a: { b11: { r2: number; applied: boolean }; b12: { r2: number; applied: boolean } };
      b: { b11: { r2: number; applied: boolean }; b12: { r2: number; applied: boolean } };
    } | null;
    adaptiveScales: Record<string, number>;
    adaptiveSigma: Record<string, number>;
  };
}

/**
 * Runs classify → denoise → MMU → stats → overlay on already-parsed inputs.
 * Size checks guarantee the rasters match the prepared analysis grid.
 * `evidence` feeds the fused rules only (legacy ignores it entirely).
 * `cached` (Phase-thresholds) re-classifies from a previous run's derived
 * grids — no fetch, no derive — for zero-PU threshold/preset re-runs.
 */
export function processCompare(
  input: RunCompareInput,
  inputs: RasterInputs,
  evidence: EvidenceInputs = {},
  cached?: DerivedIndexGrids,
): CompareArtifact {
  const prep = prepareCompare(input);
  const { bbox, grid, width, height, baseThresholds, windowDays, gapDays, minPatchHa, engine, inputMode, estimatedPu } = prep;
  // Fused and ML rules exist on the v2 composite machinery only — a request
  // against v1 inputs degrades to legacy (recorded honestly in metadata).
  const rules: CompareRules =
    input.rules && input.rules !== "legacy" && engine === "v2" ? input.rules : "legacy";
  const speckle: CompareSpeckle = input.speckle ?? "gentle";
  // Phase-thresholds: any override makes the run Custom (recorded in the
  // metadata; v2 adaptive scaling is bypassed for deterministic results).
  const customThresholds = hasThresholdOverrides(input.thresholds);
  // Consume the inputs object up front (it is a throwaway for every caller):
  // raw bands are released as soon as their index stacks are derived, exactly
  // like the original fetch path, so peak memory stays one side at a time.
  let parsedA = inputs.parsedA ?? null;
  let parsedB = inputs.parsedB ?? null;
  const sideA = inputs.sideA ?? null;
  const sideB = inputs.sideB ?? null;
  inputs.parsedA = null;
  inputs.parsedB = null;
  inputs.sideA = null;
  inputs.sideB = null;
  const gapFill = inputs.gapFill ?? null;
  inputs.gapFill = null;

  const checkSize = (w: number, h: number) => {
    if (w !== width || h !== height) {
      throw Object.assign(new Error("Unexpected raster size from Copernicus."), {
        status: 502,
        code: "CDSE_BAD_GRID",
      });
    }
  };
  if (parsedA && parsedB) {
    checkSize(parsedA.width, parsedA.height);
    checkSize(parsedB.width, parsedB.height);
  } else if (sideA && sideB) {
    checkSize(sideA.width, sideA.height);
    checkSize(sideB.width, sideB.height);
  }

  const inside = rasterizeAreaMask(input.geometry, grid);
  // Phase 2: classification, stats and events run 1 px inside the polygon —
  // boundary slivers never become phantom patches. Coverage/gap-fill
  // diagnostics keep the full mask.
  const insideClass = erodeMask(inside, width, height, 1);
  const haloRadius = engine === "v2" ? COMPOSITE_ERODE_RADIUS : 1;

  let classGrid: Uint8Array | null = null;
  let valid: Uint8Array | null = null;
  let effective: ScaledThresholds = baseThresholds;
  let tiers: Uint8Array | null = null;
  let subs: Uint8Array | null = null;
  let persist: Uint8Array | null = null;
  let conf: Uint8Array | null = null;
  let shortGap = false;
  let engineStats: EngineStats | undefined;
  let sharpenStats: {
    a: { b11: { r2: number; applied: boolean }; b12: { r2: number; applied: boolean } };
    b: { b11: { r2: number; applied: boolean }; b12: { r2: number; applied: boolean } };
  } | null = null;
  // Phase 0 diagnostics inputs — set by whichever engine branch runs.
  let idxA: IndexRasters | null = null;
  let idxB: IndexRasters | null = null;
  let preCombined: Uint8Array | null = null;
  let validA: Uint8Array | null = null;
  let validB: Uint8Array | null = null;
  let nodataA: Uint8Array | null = null;
  let nodataB: Uint8Array | null = null;
  let cloudyA: Uint8Array | null = null;
  let cloudyB: Uint8Array | null = null;
  // Phase-thresholds: also hoisted for the derived-grids capture (re-runs
  // with new thresholds re-classify from these with zero Process API calls).
  let aRecent: RecentIndices | null = null;
  let bRecent: RecentIndices | null = null;
  let normalization: ReturnType<typeof normalizeBands> | null = null;
  let co: ReturnType<typeof estimateShift> | null = null;
  let adaptiveScales: Record<string, number> | null = null;
  let adaptiveSigma: Record<string, number> | null = null;

  // Phase 2.5-2.8 classification — shared by the fresh v2 path AND the
  // Phase-thresholds cached re-classification (same grids, new thresholds).
  const classifyV2FromGrids = (
    aIdx: V2Indices,
    bIdx: V2Indices,
    aRecentSrc: RecentIndices,
    bRecentSrc: RecentIndices,
    validMask: Uint8Array,
    appliedScales: Record<string, number>,
    sigmaSrc: Record<string, number>,
  ): void => {
    const seasonalLossTag = seasonalTag(input.dateB, "loss");
    const seasonalGainTag = seasonalTag(input.dateB, "gain");
    const shortGapLocal = gapDays >= 0 && gapDays < V2_SHORT_GAP_DAYS;
    shortGap = shortGapLocal;
    const base = {
      a: aIdx,
      b: bIdx,
      aRecent: aRecentSrc,
      bRecent: bRecentSrc,
      valid: validMask,
      inside: insideClass,
      t: effective,
      scales: appliedScales,
      seasonalLossTag,
      seasonalGainTag,
      shortGap: shortGapLocal,
    };
    let out: ClassifyV2Output;
    if (rules === "fused") {
      const fusedOut = classifyFused({
        ...base,
        evidence: {
          sar: evidence.sar ?? null,
          prior: evidence.prior ?? null,
          shadow: evidence.terrain?.shadow ?? null,
        },
      });
      conf = fusedOut.confGrid;
      out = fusedOut;
    } else if (rules === "ml") {
      // Phase 4: trained softmax model (CDSE_ML_MODEL_MISSING if untrained).
      const mlOut = classifyModel(
        {
          ...base,
          evidence: {
            sar: evidence.sar ?? null,
            prior: evidence.prior ?? null,
            shadow: evidence.terrain?.shadow ?? null,
          },
        },
        loadMlModel(),
      );
      conf = mlOut.confGrid;
      out = mlOut;
    } else {
      out = classifyV2(base);
    }
    classGrid = out.classGrid;
    tiers = out.tierGrid;
    subs = out.subGrid;
    persist = out.persistGrid;
    const decided = out.persistentPixels + out.transientPixels;
    engineStats = {
      // Non-null by construction: the fresh v2 path always derives both and
      // the cached path restores them from its own v2 capture.
      normalization: normalization as NonNullable<typeof normalization>,
      coReg: co as NonNullable<typeof co>,
      adaptive: { scales: appliedScales, sigma: sigmaSrc },
      persistence: {
        checked: decided > 0,
        persistentPct:
          decided > 0 ? Math.round((100 * out.persistentPixels) / decided) : null,
      },
      cropCycle: { tag: seasonalLossTag ?? seasonalGainTag },
      cvaMean: out.cvaMean,
      ...(sharpenStats ? { sharpen: sharpenStats } : {}),
    };
  };

  if (cached) {
    // Phase-thresholds re-classification: restore the captured per-date
    // grids (post co-registration/normalisation/derive) and the evidence —
    // no fetch, no derive; classify → denoise → MMU → stats below as usual.
    checkSize(cached.width, cached.height);
    idxA = cached.idxA;
    idxB = cached.idxB;
    validA = cached.validA;
    validB = cached.validB;
    nodataA = cached.nodataA;
    nodataB = cached.nodataB;
    cloudyA = cached.cloudyA;
    cloudyB = cached.cloudyB;
    preCombined = cached.preCombined;
    valid = cached.valid;
    aRecent = cached.aRecent;
    bRecent = cached.bRecent;
    normalization = cached.engineMeta.normalization;
    co = cached.engineMeta.coReg;
    sharpenStats = cached.engineMeta.sharpen;
    adaptiveScales = cached.engineMeta.adaptiveScales;
    adaptiveSigma = cached.engineMeta.adaptiveSigma;
    if (rules === "fused" || rules === "ml") {
      Object.assign(evidence, cached.evidence);
    }
    if (input.sensitivity === "auto" && !customThresholds) {
      effective = autoThresholds(cached.idxA, cached.idxB, cached.valid);
    } else if (engine === "v2" && !customThresholds) {
      effective = scaleThresholds(baseThresholds, cached.engineMeta.adaptiveScales);
    }
    // Classify from the restored grids — zero Process API calls.
    const scalesForRun = customThresholds
      ? { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 }
      : (adaptiveScales ?? { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 });
    if (engine === "v2" && cached.aRecent && cached.bRecent) {
      classifyV2FromGrids(
        cached.idxA as V2Indices,
        cached.idxB as V2Indices,
        cached.aRecent,
        cached.bRecent,
        valid,
        scalesForRun,
        adaptiveSigma ?? {},
      );
    } else {
      classGrid = classifyChange(cached.idxA, cached.idxB, valid, insideClass, effective);
    }
  } else if (engine === "v2" && parsedA && parsedB) {
    const pa = parsedA;
    const pb = parsedB;

    // 2.2 co-registration — before any radiometry (raw luminance match).
    const preMask = combineValidity(pa.valid, pb.valid, inside);
    co = estimateShift(pa, pb, preMask, width, height);
    if (co.applied) applyShift(pa, pa.valid, co.dx, co.dy, width, height);

    // 2.1 normalisation — A's reflectances median-matched onto B (guarded).
    const normMask = co.applied
      ? combineValidity(pa.valid, pb.valid, inside)
      : preMask;
    normalization = normalizeBands(pa, pb, normMask);

    // SHARPEN_SWIR (opt-in) — regression-based B11/B12 sharpening between
    // normalisation and index derivation: NDBI/MNDWI/BSI gain 10 m detail.
    // Recent-orbit indices arrive pre-computed and stay unsharpened (see
    // sharpen.ts). v1 legacy inputs are untouched (baseline comparability).
    sharpenStats = input.sharpen
      ? {
          a: sharpenSwir(pa, width, height, pa.valid),
          b: sharpenSwir(pb, width, height, pb.valid),
        }
      : null;

    // 2.3 index stacks — A last, so both raw sides stay alive for co-reg only.
    const aIdx: V2Indices = deriveV2Indices(pa);
    const bIdx: V2Indices = deriveV2Indices(pb);
    const aRecentDerived: RecentIndices = {
      ndvi: pa.recentNdvi,
      mndwi: pa.recentMndwi,
      ndbi: pa.recentNdbi,
    };
    const bRecentDerived: RecentIndices = {
      ndvi: pb.recentNdvi,
      mndwi: pb.recentMndwi,
      ndbi: pb.recentNdbi,
    };
    aRecent = aRecentDerived;
    bRecent = bRecentDerived;
    const sideValidA = pa.valid;
    const sideValidB = pb.valid;
    // Phase 0 diagnostics: coverage flags, pre-dilation mask + indices.
    const flagsA = compositeSideFlags(pa);
    const flagsB = compositeSideFlags(pb);
    validA = sideValidA;
    validB = sideValidB;
    nodataA = flagsA.nodata;
    nodataB = flagsB.nodata;
    cloudyA = flagsA.cloudy;
    cloudyB = flagsB.cloudy;
    idxA = aIdx;
    idxB = bIdx;
    preCombined = combineValidity(sideValidA, sideValidB, inside);
    parsedA = null;
    parsedB = null;

    valid = dilateInvalid(preCombined, width, height, haloRadius);

    // 2.4 adaptive thresholds, then 2.5-2.8 classification. Phase 2 "auto"
    // sensitivity derives thresholds from this pair's noise instead and
    // bypasses the adaptive scale (all scales report as 1). Phase-thresholds:
    // a Custom run uses exactly the values shown in the editor — no adaptive
    // rescale (the live histogram math must match what applies).
    const adaptive = adaptiveThresholds(aIdx, bIdx, valid, baseThresholds);
    adaptiveScales = adaptive.scales;
    adaptiveSigma = adaptive.sigma;
    const autoT =
      input.sensitivity === "auto" && !customThresholds ? autoThresholds(aIdx, bIdx, valid) : null;
    effective = autoT ?? (customThresholds ? baseThresholds : adaptive.t);
    const appliedScales = customThresholds
      ? { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 }
      : autoT
        ? { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 }
        : adaptive.scales;
    // 2.5-2.8 classification (shared closure — see classifyV2FromGrids).
    classifyV2FromGrids(
      aIdx,
      bIdx,
      aRecentDerived,
      bRecentDerived,
      valid,
      appliedScales,
      adaptive.sigma,
    );
  } else if (sideA && sideB) {
    // Phase 0 diagnostics: coverage flags + pre-dilation mask + indices.
    const flagsA = singleSideFlags(sideA.valid, sideA.nodata ?? null);
    const flagsB = singleSideFlags(sideB.valid, sideB.nodata ?? null);
    validA = sideA.valid;
    validB = sideB.valid;
    nodataA = flagsA.nodata;
    nodataB = flagsB.nodata;
    cloudyA = flagsA.cloudy;
    cloudyB = flagsB.cloudy;
    idxA = sideA.indices;
    idxB = sideB.indices;
    preCombined = combineValidity(sideA.valid, sideB.valid, inside);
    valid = dilateInvalid(preCombined, width, height, haloRadius);
    if (input.sensitivity === "auto" && !customThresholds) {
      effective = autoThresholds(sideA.indices, sideB.indices, valid);
    }
    classGrid = classifyChange(sideA.indices, sideB.indices, valid, insideClass, effective);
  } else {
    throw Object.assign(new Error("Missing analysis inputs."), { status: 500 });
  }
  // The classify closures above are opaque to control-flow analysis — prove
  // the assignment here so the rest of the pipeline sees non-null grids.
  if (!classGrid || !valid) {
    throw Object.assign(new Error("Missing analysis inputs."), { status: 500 });
  }

  // Phase 2: per-pixel magnitude (max |Δ_i| / applied threshold) drives the
  // gentle despeckle, the strong-small MMU escape and the v1 confidence tiers.
  const changeMagnitude = idxA && idxB ? magnitudeGrid(idxA, idxB, effective, valid) : null;
  if (engine === "v1" && changeMagnitude && !tiers) {
    tiers = new Uint8Array(classGrid.length);
    for (let i = 0; i < classGrid.length; i++) {
      const code = classGrid[i];
      if (code < CLASS.vegGain || code > CLASS.waterLoss) continue;
      const m = changeMagnitude[i];
      tiers[i] = m >= 2 ? 3 : m >= 1.25 ? 2 : 1;
    }
  }

  // Noise control: legacy = 2 majority passes; gentle (default) = magnitude-
  // aware component removal that keeps strong small changes. Then speckle-
  // hole fill and the MMU cut (confidence- and magnitude-aware escapes).
  // Phase 0: class counts snapshotted at each stage (raw → despeckle → min patch).
  const stageRaw = countClasses(classGrid);
  const minPixels = minPatchPixels(minPatchHa, grid.metersX, grid.metersY);
  // Denoise must never resurrect the 1-px eroded boundary ring: skip masked
  // AND non-eroded-inside pixels (ring pixels keep their outside class).
  const denoiseValid = new Uint8Array(valid.length);
  for (let i = 0; i < valid.length; i++) {
    denoiseValid[i] = valid[i] === 1 && insideClass[i] === 1 ? 1 : 0;
  }
  if (speckle === "legacy") {
    classGrid = majorityFilter(classGrid, denoiseValid, width, height, 2);
  } else {
    gentleDespeckle(classGrid, width, height, minPixels, changeMagnitude);
  }
  const stageMajority = countClasses(classGrid);
  const holesFilled = fillSmallHoles(classGrid, denoiseValid, width, height, minPixels);
  const { labels, removedCount } = labelPatches(
    classGrid,
    width,
    height,
    minPixels,
    tiers,
    speckle === "gentle" ? changeMagnitude : null,
  );
  const stageMinPatch = countClasses(classGrid);

  // Phase 0 diagnostics: coverage + stage counts + patch sizes/edge + histograms.
  const tLines = histogramThresholds(effective);
  const diagnostics: CompareDiagnostics = {
    grid: { width, height, metersPerPixel: grid.metersPerPixel },
    coverage: computeCoverage({
      inside,
      validA: validA!,
      validB: validB!,
      nodataA,
      nodataB,
      cloudyA,
      cloudyB,
    }),
    stages: { raw: stageRaw, majority: stageMajority, minPatch: stageMinPatch },
    holesFilled,
    patches: patchDiagnostics(
      labels,
      edgeProximityMask(inside, width, height, 2),
      removedCount,
    ),
    histograms: {
      ndvi: deltaHistogram(idxA!.ndvi, idxB!.ndvi, preCombined!, tLines.ndvi),
      mndwi: deltaHistogram(idxA!.mndwi, idxB!.mndwi, preCombined!, tLines.mndwi),
      ndbi: deltaHistogram(idxA!.ndbi, idxB!.ndbi, preCombined!, tLines.ndbi),
    },
  };
  if ((rules === "fused" || rules === "ml") && conf && tiers) {
    // Shape evidence runs on the KEPT patches (post-denoise, post-MMU).
    applyShapeEvidence({ classGrid, labels, confGrid: conf, tierGrid: tiers, width, height });
  }

  // Phase 1 map layers: coverage reasons (same precedence as diagnostics),
  // gap-fill source marks, and int8 Δ-index magnitude planes.
  const coverageRaster = coverageReasonRaster({
    inside,
    validA: validA!,
    validB: validB!,
    nodataA,
    nodataB,
    cloudyA,
    cloudyB,
  });
  const gapSource = gapFill?.source ?? new Uint8Array(width * height);
  const magnitude = magnitudePlanes(idxA!, idxB!, effective);
  // Phase 2: per-pixel edge flag — boundary / masked / gap-fill seam.
  const edgeMask = edgeEventMask(insideClass, valid, gapSource, width, height);

  let zones: Int16Array | null = null;
  let zoneMeta: ZoneMeta[] | null = null;
  if (input.areaLevel === "district" && input.zones && input.zones.length > 0) {
    zones = rasterizeZones(
      input.zones.map((z) => ({ id: z.id, geometry: z.geometry })),
      grid,
    );
    zoneMeta = input.zones.map((z) => ({ id: z.id, name: z.name }));
  }

  const core = computeStats({
    classGrid,
    labels,
    grid,
    zones,
    zoneMeta,
    tiers,
    subs,
    persist,
    conf,
    shortGap,
    edgeMask,
  });
  // Phase 5 (#13): full-coverage vector layer for events/exports — kept off
  // the client-facing result (except the count), so response size stays small.
  const patchVectors = buildPatchVectors(
    classGrid,
    labels,
    grid,
    (grid.metersX * grid.metersY) / M2_PER_HA,
    { tiers, subs, persist, conf, shortGap, edgeMask },
    undefined,
    zones,
    zoneMeta,
  );
  // Phase 2: per-class patch counts + edge totals for the Events header.
  let eventsEdgeTotal = 0;
  const eventsByClassMap = new Map<number, { count: number; edgeCount: number }>();
  for (const feature of patchVectors.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const code = Number(props.classCode ?? -1);
    const slot = eventsByClassMap.get(code) ?? { count: 0, edgeCount: 0 };
    slot.count += 1;
    if (props.edge === true) {
      slot.edgeCount += 1;
      eventsEdgeTotal += 1;
    }
    eventsByClassMap.set(code, slot);
  }
  const eventsByClass = Array.from(eventsByClassMap, ([classCode, v]) => ({ classCode, ...v }));
  const result: CompareStats = {
    ...core,
    metadata: {
      areaName: input.areaName,
      areaLevel: input.areaLevel,
      areaId: input.areaId,
      dateA: input.dateA,
      dateB: input.dateB,
      gapDays,
      sceneA: input.sceneA ?? null,
      sceneB: input.sceneB ?? null,
      width,
      height,
      metersPerPixel: grid.metersPerPixel,
      coarse: grid.metersPerPixel > 10,
      sensitivity: input.sensitivity,
      minPatchHa,
      speckle,
      engine,
      rules,
      ...(rules === "fused" || rules === "ml" ? { evidence: evidenceMeta(evidence) } : {}),
      ...(sharpenStats ? { sharpen: true } : {}),
      inputMode,
      compositeWindowDays: windowDays,
      estimatedPu,
      // Everything actually applied — including the state gates (#17) and,
      // for v2, the adaptive-scaled values plus engine diagnostics.
      thresholds: {
        waterGainDMndwi: effective.waterGainD,
        waterLossDMndwi: effective.waterLossD,
        vegLossDNdvi: effective.vegLossD,
        vegGainDNdvi: effective.vegGainD,
        bareBuiltDNdbi: effective.bareBuiltD,
        bareBuiltDNdviMax: effective.bareBuiltNdviMax,
        bareBuiltMaxMndwi: effective.bareBuiltMaxMndwi,
        waterGainMndwiMin: effective.waterGainMndwiMin,
        waterLossMndwiMin: effective.waterLossMndwiMin,
      },
      // Phase-thresholds: mark Custom runs and the preset they started from,
      // and echo the raw overrides so saved queries / re-runs round-trip.
      ...(customThresholds
        ? {
            thresholdsCustom: true,
            thresholdsPreset: input.sensitivity,
            thresholdOverrides: input.thresholds ?? undefined,
          }
        : {}),
      ...(engineStats ? { engineStats } : {}),
      diagnostics,
      // Phase 1: coverage-rescue statement for the method card (absent when
      // no rescue ran or it recovered nothing).
      ...(gapFill && gapFill.filledPct > 0
        ? {
            gapFill: {
              windowDays: gapFill.windowDays,
              sides: gapFill.sides,
              filledPct: gapFill.filledPct,
            },
          }
        : {}),
      generatedAt: new Date().toISOString(),
    },
    // Full event count for the Events tab header; the client only receives
    // the first ANALYZE_EVENTS_CAP events inline (fetched in analyze.ts).
    eventsTotal: patchVectors.features.length,
    eventsEdgeTotal,
    eventsByClass,
    // Phase-thresholds: compact Δ histograms for the editor's live feedback.
    histograms: diagnostics.histograms,
  };

  // Phase-thresholds: capture the derived grids (post derive / co-reg /
  // normalisation / gap-fill merge) so a thresholds-only re-run re-classifies
  // with zero Process API calls. Only whole-AOI runs ask for this.
  let derived: DerivedIndexGrids | undefined;
  if (input.captureDerived && !cached && idxA && idxB && validA && validB && preCombined) {
    derived = {
      engine,
      width,
      height,
      idxA,
      idxB,
      validA,
      validB,
      nodataA,
      nodataB,
      cloudyA,
      cloudyB,
      preCombined,
      valid,
      aRecent,
      bRecent,
      gapSource,
      gapFillInfo: gapFill,
      evidence,
      engineMeta: {
        normalization,
        coReg: co,
        sharpen: sharpenStats,
        adaptiveScales: adaptiveScales ?? { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 },
        adaptiveSigma: adaptiveSigma ?? {},
      },
    };
  }

  const overlayPng = encodePng(classToRgba(classGrid, width), width, height);
  const classGz = deflateSync(classGrid);
  const coverageGz = deflateSync(coverageRaster);
  const sourceGz = deflateSync(gapSource);
  const magnitudeGz = {
    ndvi: deflateSync(magnitude.ndvi),
    mndwi: deflateSync(magnitude.mndwi),
    ndbi: deflateSync(magnitude.ndbi),
    combined: deflateSync(magnitude.combined),
  };

  return {
    result,
    overlayPng,
    classGz,
    coverageGz,
    sourceGz,
    magnitudeGz,
    classGrid,
    labels,
    patchVectors,
    coverage: coverageRaster,
    source: gapSource,
    magnitude,
    edgeMask,
    tiers,
    width,
    height,
    bbox,
    ...(derived ? { derived } : {}),
  };
}
