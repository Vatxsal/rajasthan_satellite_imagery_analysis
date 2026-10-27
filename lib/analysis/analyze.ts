/**
 * Change-detection orchestration: fetch A → fetch B → classify → denoise →
 * MMU → stats → overlay PNG. Fetches are sequential (matches the documented
 * progress stages and halves peak memory); rasters are released as soon as
 * their index bands are extracted.
 */
import { deflateSync } from "node:zlib";
import { bboxFromGeometry, computeOutputSize, type ClipGeometry } from "@/lib/cdse/geometry";
import {
  DEFAULT_MAX_PX,
  DEFAULT_MIN_PATCH_HA,
  scaledThresholds,
} from "./config";
import { combineValidity, classifyChange, dilateInvalid } from "./classify";
import { fetchCompareRaster } from "./fetch";
import { labelPatches, majorityFilter, minPatchPixels } from "./filter";
import { makeAnalysisGrid } from "./grid";
import { rasterizeAreaMask, rasterizeZones } from "./mask";
import { classToRgba, encodePng } from "./png";
import { parseCompareRaster, toIndexRasters } from "./parse";
import { computeStats, type ZoneMeta } from "./stats";
import type { Sensitivity } from "./config";
import type { CompareStats, DateSceneMeta } from "./types";

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

  // --- date A ---------------------------------------------------------------
  onStage?.("fetch-a");
  let bufferA: Buffer | null = await fetchCompareRaster(input.geometry, input.dateA, bbox, {
    width,
    height,
  });
  const parsedA = await parseCompareRaster(bufferA);
  bufferA = null;

  // --- date B ---------------------------------------------------------------
  onStage?.("fetch-b");
  let bufferB: Buffer | null = await fetchCompareRaster(input.geometry, input.dateB, bbox, {
    width,
    height,
  });
  const parsedB = await parseCompareRaster(bufferB);
  bufferB = null;

  // --- analysis -------------------------------------------------------------
  onStage?.("analyze");
  if (parsedA.width !== width || parsedA.height !== height || parsedB.width !== width || parsedB.height !== height) {
    throw Object.assign(new Error("Unexpected raster size from Copernicus."), {
      status: 502,
      code: "CDSE_BAD_GRID",
    });
  }

  const a = toIndexRasters(parsedA);
  const b = toIndexRasters(parsedB);
  const inside = rasterizeAreaMask(input.geometry, grid);
  const valid = dilateInvalid(
    combineValidity(parsedA.valid, parsedB.valid, inside),
    width,
    height,
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
