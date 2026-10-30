/**
 * Change-detection orchestration: fetch A → fetch B → classify → denoise →
 * MMU → stats → overlay PNG. Fetches are sequential (matches the documented
 * progress stages and halves peak memory); rasters are released as soon as
 * their index stacks are derived.
 *
 * Engine v1 fetches each date's single UTC day (server-side indices) and runs
 * the classic single-index classifier.
 * Engine v2 fetches a ±window median composite per side (12-band raw
 * reflectance + QC + recent-orbit indices) and runs the Phase 2 pipeline:
 * co-registration (2.2) → radiometric normalisation (2.1) → extended index
 * stack (2.3) → adaptive thresholds (2.4) → multi-index vote with CVA,
 * sub-labels, persistence and confidence tiers (2.5-2.8). Everything from
 * the majority filter onwards is shared.
 */
import { deflateSync } from "node:zlib";
import { bboxFromGeometry, computeOutputSize, type ClipGeometry } from "@/lib/cdse/geometry";
import type { BBox } from "@/lib/data";
import {
  COMPOSITE_ERODE_RADIUS,
  COMPOSITE_WINDOW_DAYS_DEFAULT,
  COMPOSITE_WINDOW_DAYS_MAX,
  DEFAULT_MAX_PX,
  DEFAULT_MIN_PATCH_HA,
  V2_SHORT_GAP_DAYS,
  scaledThresholds,
  seasonalTag,
  type ScaledThresholds,
} from "./config";
import { combineValidity, classifyChange, dilateInvalid } from "./classify";
import { fetchCompareCompositeRaster, fetchCompareRaster } from "./fetch";
import { labelPatches, majorityFilter, minPatchPixels } from "./filter";
import { makeAnalysisGrid } from "./grid";
import { rasterizeAreaMask, rasterizeZones } from "./mask";
import { classToRgba, encodePng } from "./png";
import { parseCompareRaster, parseCompositeRaster, toIndexRasters, type ParsedCompositeRaster } from "./parse";
import { computeStats, type ZoneMeta } from "./stats";
import {
  adaptiveThresholds,
  applyShift,
  classifyV2,
  deriveV2Indices,
  estimateShift,
  normalizeBands,
} from "./v2";
import type { Sensitivity } from "./config";
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
  /** v2 input mode; engine v1 always runs "single". */
  inputMode?: CompareInputMode;
  /** v2 ±composite window in days (0-15). */
  compositeWindowDays?: number;
}

export interface CompareArtifact {
  result: CompareStats;
  overlayPng: Buffer;
  /** Deflated raw class raster — stored in the LRU for GeoTIFF export. */
  classGz: Buffer;
  width: number;
  height: number;
  bbox: [number, number, number, number];
}

function dayGap(dateA: string, dateB: string): number {
  return Math.round((Date.parse(dateB) - Date.parse(dateA)) / 86_400_000);
}

export async function runCompare(
  input: RunCompareInput,
  onStage?: (stage: CompareStage) => void,
): Promise<CompareArtifact> {
  const bbox = bboxFromGeometry(input.geometry);
  if (!bbox) {
    throw Object.assign(new Error("Geometry has no coordinates."), {
      status: 400,
      code: "INVALID_GEOMETRY",
    });
  }
  const { width, height } = computeOutputSize(bbox, input.maxPx ?? DEFAULT_MAX_PX);
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
  const gapDays = dayGap(input.dateA, input.dateB);

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
  ): Promise<{ indices: IndexRasters; valid: Uint8Array; width: number; height: number }> {
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

  let parsedA: ParsedCompositeRaster | null = null;
  let parsedB: ParsedCompositeRaster | null = null;
  let sideA: { indices: IndexRasters; valid: Uint8Array; width: number; height: number } | null = null;
  let sideB: { indices: IndexRasters; valid: Uint8Array; width: number; height: number } | null = null;
  if (engine === "v2") {
    parsedA = await fetchCompositeSide("fetch-a", input.dateA, input.dateB, bbox);
    parsedB = await fetchCompositeSide("fetch-b", input.dateB, input.dateA, bbox);
  } else {
    sideA = await fetchSingleSide("fetch-a", input.dateA, bbox);
    sideB = await fetchSingleSide("fetch-b", input.dateB, bbox);
  }

  // --- analysis -------------------------------------------------------------
  onStage?.("analyze");
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

  // Shared noise control + MMU (majority filter may impute a few change
  // pixels — stats.ts assigns them the conservative low tier).
  classGrid = majorityFilter(classGrid, valid, width, height);
  const minPixels = minPatchPixels(minPatchHa, grid.metersX, grid.metersY);
  const { labels } = labelPatches(classGrid, width, height, minPixels);

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

  return { result, overlayPng, classGz, width, height, bbox };
}
