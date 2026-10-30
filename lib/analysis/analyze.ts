/**
 * Change-detection orchestration: fetch A → fetch B → classify → denoise →
 * MMU → stats → overlay PNG. Fetches are sequential (matches the documented
 * progress stages and halves peak memory); rasters are released as soon as
 * their index bands are extracted.
 *
 * Engine v1 fetches each date's single UTC day (server-side indices).
 * Engine v2 fetches ±compositeWindowDays medians (client-side indices, exact
 * v1 formulas) and doubles the invalidity halo to 2 px — the classifier and
 * every stage after it are shared.
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
  scaledThresholds,
} from "./config";
import { combineValidity, classifyChange, dilateInvalid } from "./classify";
import { deriveIndices } from "./composite";
import { fetchCompareCompositeRaster, fetchCompareRaster } from "./fetch";
import { labelPatches, majorityFilter, minPatchPixels } from "./filter";
import { makeAnalysisGrid } from "./grid";
import { rasterizeAreaMask, rasterizeZones } from "./mask";
import { classToRgba, encodePng } from "./png";
import { parseCompareRaster, parseCompositeRaster, toIndexRasters } from "./parse";
import { computeStats, type ZoneMeta } from "./stats";
import type { Sensitivity } from "./config";
import type { CompareEngine, CompareInputMode, CompareStats, DateSceneMeta, IndexRasters } from "./types";

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
  const thresholds = scaledThresholds(input.sensitivity);

  const engine: CompareEngine = input.engine ?? "v1";
  const useComposite =
    engine === "v2" && (input.inputMode ?? "composite") === "composite";
  const windowDays = Math.min(
    Math.max(input.compositeWindowDays ?? COMPOSITE_WINDOW_DAYS_DEFAULT, 0),
    COMPOSITE_WINDOW_DAYS_MAX,
  );

  async function fetchSide(
    stage: CompareStage,
    date: string,
    otherDate: string,
    gridBox: BBox,
  ): Promise<{ indices: IndexRasters; valid: Uint8Array; width: number; height: number }> {
    onStage?.(stage);
    const size = { width, height };
    if (useComposite) {
      let buffer: Buffer | null = await fetchCompareCompositeRaster(
        input.geometry,
        date,
        gridBox,
        size,
        windowDays,
        otherDate,
      );
      const parsed = await parseCompositeRaster(buffer);
      buffer = null;
      return {
        indices: deriveIndices(parsed),
        valid: parsed.valid,
        width: parsed.width,
        height: parsed.height,
      };
    }
    let buffer: Buffer | null = await fetchCompareRaster(input.geometry, date, gridBox, size);
    const parsed = await parseCompareRaster(buffer);
    buffer = null;
    return {
      indices: toIndexRasters(parsed),
      valid: parsed.valid,
      width: parsed.width,
      height: parsed.height,
    };
  }

  const sideA = await fetchSide("fetch-a", input.dateA, input.dateB, bbox);
  const sideB = await fetchSide("fetch-b", input.dateB, input.dateA, bbox);

  // --- analysis -------------------------------------------------------------
  onStage?.("analyze");
  if (
    sideA.width !== width ||
    sideA.height !== height ||
    sideB.width !== width ||
    sideB.height !== height
  ) {
    throw Object.assign(new Error("Unexpected raster size from Copernicus."), {
      status: 502,
      code: "CDSE_BAD_GRID",
    });
  }

  const a = sideA.indices;
  const b = sideB.indices;
  const inside = rasterizeAreaMask(input.geometry, grid);
  const valid = dilateInvalid(
    combineValidity(sideA.valid, sideB.valid, inside),
    width,
    height,
    useComposite ? COMPOSITE_ERODE_RADIUS : 1,
  );

  let classGrid = classifyChange(a, b, valid, inside, thresholds);
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

  const t = thresholds;
  const core = computeStats({ classGrid, labels, grid, zones, zoneMeta });
  const result: CompareStats = {
    ...core,
    metadata: {
      areaName: input.areaName,
      areaLevel: input.areaLevel,
      dateA: input.dateA,
      dateB: input.dateB,
      gapDays: dayGap(input.dateA, input.dateB),
      sceneA: input.sceneA ?? null,
      sceneB: input.sceneB ?? null,
      width,
      height,
      metersPerPixel: grid.metersPerPixel,
      coarse: grid.metersPerPixel > 10,
      sensitivity: input.sensitivity,
      minPatchHa,
      engine,
      inputMode: useComposite ? "composite" : "single",
      compositeWindowDays: useComposite ? windowDays : 0,
      thresholds: {
        waterGainDMndwi: t.waterGainD,
        waterLossDMndwi: t.waterLossD,
        vegLossDNdvi: t.vegLossD,
        vegGainDNdvi: t.vegGainD,
        bareBuiltDNdbi: t.bareBuiltD,
        bareBuiltDNdviMax: t.bareBuiltNdviMax,
      },
      generatedAt: new Date().toISOString(),
    },
  };

  const overlayPng = encodePng(classToRgba(classGrid, width), width, height);
  const classGz = deflateSync(classGrid);

  return { result, overlayPng, classGz, width, height, bbox };
}
