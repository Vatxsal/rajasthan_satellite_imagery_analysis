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
import { bboxFromGeometry, computeOutputSize, type ClipGeometry } from "../cdse/geometry";
import type { BBox } from "@/lib/data";
import {
  COMPOSITE_ERODE_RADIUS,
  COMPOSITE_WINDOW_DAYS_DEFAULT,
  COMPOSITE_WINDOW_DAYS_MAX,
  DEFAULT_MAX_PX,
  DEFAULT_MIN_PATCH_HA,
  GRID_MIN_PX,
  M2_PER_HA,
  V2_SHORT_GAP_DAYS,
  scaledThresholds,
  seasonalTag,
  type ScaledThresholds,
  type Sensitivity,
} from "./config";
import { combineValidity, classifyChange, dilateInvalid } from "./classify";
import { fillSmallHoles, labelPatches, majorityFilter, minPatchPixels } from "./filter";
import { makeAnalysisGrid, nativeLongSidePx } from "./grid";
import { rasterizeAreaMask, rasterizeZones } from "./mask";
import { classToRgba, encodePng } from "./png";
import type { ParsedCompositeRaster } from "./parse";
import {
  V1_INPUT_BANDS,
  V2_INPUT_BANDS,
  compositeSamples,
  estimateAnalysisPu,
} from "./pu";
import { buildPatchVectors, computeStats, type ZoneMeta } from "./stats";
import {
  adaptiveThresholds,
  applyShift,
  classifyV2,
  deriveV2Indices,
  estimateShift,
  normalizeBands,
} from "./v2";
import type {
  CompareEngine,
  CompareInputMode,
  CompareStats,
  DateSceneMeta,
  EngineStats,
  IndexRasters,
} from "./types";
import type { RecentIndices, V2Indices } from "./v2";

export type CompareStage = "fetch-a" | "fetch-b" | "analyze";

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
  sensitivity: Sensitivity;
  minPatchHa?: number;
  /** Long-side cap of the analysis grid (COMPARE_MAX_PX). */
  maxPx?: number;
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
}

export interface CompareArtifact {
  result: CompareStats;
  overlayPng: Buffer;
  /** Deflated raw class raster — stored for GeoTIFF export. */
  classGz: Buffer;
  /** Classified raster (CLASS codes) — validation/events vectorize from this. */
  classGrid: Uint8Array;
  /** Kept-patch labels from labelPatches (0 = no kept patch). */
  labels: Int32Array;
  /** Full-coverage change patches, largest-first cap (Phase 5, #13). */
  patchVectors: GeoJSON.FeatureCollection;
  width: number;
  height: number;
  bbox: [number, number, number, number];
}

/** One v1 side: parsed index rasters for a single UTC day. */
export interface CompareSide {
  indices: IndexRasters;
  valid: Uint8Array;
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
  const maxPx = input.maxPx ?? DEFAULT_MAX_PX;
  const nativeCap = Math.max(GRID_MIN_PX, Math.min(maxPx, Math.floor(nativeLongSidePx(bbox))));
  const { width, height } = computeOutputSize(bbox, nativeCap);
  const grid = makeAnalysisGrid(bbox, width, height);
  const minPatchHa = input.minPatchHa ?? DEFAULT_MIN_PATCH_HA;
  const baseThresholds = scaledThresholds(input.sensitivity);

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
  const estimatedPu =
    Math.round(
      estimateAnalysisPu({ width, height, inputBands, float: true, samples }) * 100,
    ) / 100;
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
 * Runs classify → denoise → MMU → stats → overlay on already-parsed inputs.
 * Size checks guarantee the rasters match the prepared analysis grid.
 */
export function processCompare(
  input: RunCompareInput,
  inputs: RasterInputs,
): CompareArtifact {
  const prep = prepareCompare(input);
  const { bbox, grid, width, height, baseThresholds, windowDays, gapDays, minPatchHa, engine, inputMode, estimatedPu } = prep;
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
  const haloRadius = engine === "v2" ? COMPOSITE_ERODE_RADIUS : 1;

  let classGrid: Uint8Array;
  let valid: Uint8Array;
  let effective: ScaledThresholds = baseThresholds;
  let tiers: Uint8Array | null = null;
  let subs: Uint8Array | null = null;
  let persist: Uint8Array | null = null;
  let shortGap = false;
  let engineStats: EngineStats | undefined;

  if (engine === "v2" && parsedA && parsedB) {
    const pa = parsedA;
    const pb = parsedB;

    // 2.2 co-registration — before any radiometry (raw luminance match).
    const preMask = combineValidity(pa.valid, pb.valid, inside);
    const co = estimateShift(pa, pb, preMask, width, height);
    if (co.applied) applyShift(pa, pa.valid, co.dx, co.dy, width, height);

    // 2.1 normalisation — A's reflectances median-matched onto B (guarded).
    const normMask = co.applied
      ? combineValidity(pa.valid, pb.valid, inside)
      : preMask;
    const normalization = normalizeBands(pa, pb, normMask);

    // 2.3 index stacks — A last, so both raw sides stay alive for co-reg only.
    const aIdx: V2Indices = deriveV2Indices(pa);
    const bIdx: V2Indices = deriveV2Indices(pb);
    const aRecent: RecentIndices = {
      ndvi: pa.recentNdvi,
      mndwi: pa.recentMndwi,
      ndbi: pa.recentNdbi,
    };
    const bRecent: RecentIndices = {
      ndvi: pb.recentNdvi,
      mndwi: pb.recentMndwi,
      ndbi: pb.recentNdbi,
    };
    const validA = pa.valid;
    const validB = pb.valid;
    parsedA = null;
    parsedB = null;

    valid = dilateInvalid(combineValidity(validA, validB, inside), width, height, haloRadius);

    // 2.4 adaptive thresholds, then 2.5-2.8 classification.
    const adaptive = adaptiveThresholds(aIdx, bIdx, valid, baseThresholds);
    effective = adaptive.t;
    const seasonalLossTag = seasonalTag(input.dateB, "loss");
    const seasonalGainTag = seasonalTag(input.dateB, "gain");
    shortGap = gapDays >= 0 && gapDays < V2_SHORT_GAP_DAYS;

    const out = classifyV2({
      a: aIdx,
      b: bIdx,
      aRecent,
      bRecent,
      valid,
      inside,
      t: adaptive.t,
      scales: adaptive.scales,
      seasonalLossTag,
      seasonalGainTag,
      shortGap,
    });
    classGrid = out.classGrid;
    tiers = out.tierGrid;
    subs = out.subGrid;
    persist = out.persistGrid;
    const decided = out.persistentPixels + out.transientPixels;
    engineStats = {
      normalization,
      coReg: co,
      adaptive: { scales: adaptive.scales, sigma: adaptive.sigma },
      persistence: {
        checked: decided > 0,
        persistentPct:
          decided > 0 ? Math.round((100 * out.persistentPixels) / decided) : null,
      },
      cropCycle: { tag: seasonalLossTag ?? seasonalGainTag },
      cvaMean: out.cvaMean,
    };
  } else if (sideA && sideB) {
    valid = dilateInvalid(
      combineValidity(sideA.valid, sideB.valid, inside),
      width,
      height,
      haloRadius,
    );
    classGrid = classifyChange(sideA.indices, sideB.indices, valid, inside, baseThresholds);
  } else {
    throw Object.assign(new Error("Missing analysis inputs."), { status: 500 });
  }

  // Shared noise control: 2 majority passes, speckle-hole fill, then MMU
  // (confidence-aware for v2 — a high-confidence sub-MMU patch survives).
  classGrid = majorityFilter(classGrid, valid, width, height, 2);
  const minPixels = minPatchPixels(minPatchHa, grid.metersX, grid.metersY);
  fillSmallHoles(classGrid, valid, width, height, minPixels);
  const { labels } = labelPatches(classGrid, width, height, minPixels, tiers);

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
    shortGap,
  });
  // Phase 5 (#13): full-coverage vector layer for events/exports — kept off
  // the client-facing result, so response size is unchanged.
  const patchVectors = buildPatchVectors(
    classGrid,
    labels,
    grid,
    (grid.metersX * grid.metersY) / M2_PER_HA,
    { tiers, subs, persist, shortGap },
  );
  const result: CompareStats = {
    ...core,
    metadata: {
      areaName: input.areaName,
      areaLevel: input.areaLevel,
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
      engine,
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
      ...(engineStats ? { engineStats } : {}),
      generatedAt: new Date().toISOString(),
    },
  };

  const overlayPng = encodePng(classToRgba(classGrid, width), width, height);
  const classGz = deflateSync(classGrid);

  return { result, overlayPng, classGz, classGrid, labels, patchVectors, width, height, bbox };
}
