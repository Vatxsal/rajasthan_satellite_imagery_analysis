/**
 * Deterministic statistics from the classified raster: per-class areas,
 * valid-data share, tehsil zonal breakdown (district level) and top hotspots.
 * These numbers are the single source of truth for the UI *and* the AI
 * summary — the model never computes anything itself.
 */
import { CLASS, CLASS_DEFS, M2_PER_HA, classLabel } from "./config";
import { pixelToLngLat } from "./mask";
import type {
  AnalysisGrid,
  ClassStat,
  CompareStats,
  Hotspot,
  TehsilZonalStat,
} from "./types";

export interface ZoneMeta {
  id: string;
  name: string;
}

export type CompareStatsCore = Omit<CompareStats, "metadata">;

export interface ComputeStatsArgs {
  classGrid: Uint8Array;
  /** Kept-patch labels from labelPatches (0 = no kept patch). */
  labels: Int32Array;
  grid: AnalysisGrid;
  /** Zone index+1 per pixel (rasterizeZones); null when not district level. */
  zones?: Int16Array | null;
  /** Zone metadata, index-aligned with rasterizeZones input. */
  zoneMeta?: ZoneMeta[] | null;
}

export function computeStats(args: ComputeStatsArgs): CompareStatsCore {
  const { classGrid, labels, grid, zones, zoneMeta } = args;
  const pxAreaHa = (grid.metersX * grid.metersY) / M2_PER_HA;
  const counts = new Uint32Array(256);
  let insidePixels = 0;

  for (let i = 0; i < classGrid.length; i++) {
    const code = classGrid[i];
    if (code === CLASS.outside) continue;
    insidePixels += 1;
    counts[code] += 1;
  }

  const validPixels = insidePixels - counts[CLASS.masked];
  const validPct = insidePixels === 0 ? 0 : (validPixels / insidePixels) * 100;

  const classes: ClassStat[] = CLASS_DEFS.map((def) => {
    const pixels = counts[def.code];
    return {
      code: def.code,
      label: def.label,
      color: def.color,
      pixels,
      areaHa: pixels * pxAreaHa,
      areaKm2: (pixels * pxAreaHa) / 10_000,
      pctOfValid: def.code === CLASS.masked || validPixels === 0
        ? 0
        : (pixels / validPixels) * 100,
    };
  });

  let changedPixels = 0;
  for (const def of CLASS_DEFS) {
    if (def.change) changedPixels += counts[def.code];
  }

  const stats: CompareStatsCore = {
    classes,
    validPct,
    areaHa: insidePixels * pxAreaHa,
    validHa: validPixels * pxAreaHa,
    changedHa: changedPixels * pxAreaHa,
    tehsils: null,
    hotspots: [],
    negligible: changedPixels === 0,
  };

  if (zones && zoneMeta && zoneMeta.length > 0) {
    const rows = new Map<number, TehsilZonalStat>();
    const total = zones.length;
    for (let i = 0; i < total; i++) {
      const z = zones[i];
      if (z <= 0) continue;
      const code = classGrid[i];
      if (code === CLASS.outside) continue;
      let row = rows.get(z);
      if (!row) {
        const meta = zoneMeta[z - 1];
        row = {
          tehsilId: meta?.id ?? String(z),
          name: meta?.name ?? `Zone ${z}`,
          pixelsByClass: {},
          changedHa: 0,
          validPixels: 0,
          insidePixels: 0,
        };
        rows.set(z, row);
      }
      row.insidePixels += 1;
      if (code !== CLASS.masked) row.validPixels += 1;
      if (code >= CLASS.vegGain && code <= CLASS.waterLoss) {
        row.pixelsByClass[code] = (row.pixelsByClass[code] ?? 0) + 1;
        row.changedHa += pxAreaHa;
      }
    }
    stats.tehsils = Array.from(rows.values()).filter((r) => r.insidePixels > 0);
  }

  stats.hotspots = computeHotspots(classGrid, labels, grid, zones ?? null, zoneMeta ?? null, pxAreaHa);
  return stats;
}

interface PatchAcc {
  count: number;
  classCode: number;
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
  zoneCounts: Map<number, number>;
}

function computeHotspots(
  classGrid: Uint8Array,
  labels: Int32Array,
  grid: AnalysisGrid,
  zones: Int16Array | null,
  zoneMeta: ZoneMeta[] | null,
  pxAreaHa: number,
): Hotspot[] {
  const { width, bbox, pxLon, pxLat } = grid;
  const patches = new Map<number, PatchAcc>();

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0) continue;
    const col = i % width;
    const row = Math.floor(i / width);
    let acc = patches.get(label);
    if (!acc) {
      acc = {
        count: 0,
        classCode: classGrid[i],
        minCol: col,
        maxCol: col,
        minRow: row,
        maxRow: row,
        zoneCounts: new Map(),
      };
      patches.set(label, acc);
    }
    acc.count += 1;
    if (col < acc.minCol) acc.minCol = col;
    if (col > acc.maxCol) acc.maxCol = col;
    if (row < acc.minRow) acc.minRow = row;
    if (row > acc.maxRow) acc.maxRow = row;
    if (zones) {
      const z = zones[i];
      if (z > 0) acc.zoneCounts.set(z, (acc.zoneCounts.get(z) ?? 0) + 1);
    }
  }

  const hotspots: Hotspot[] = [];
  patches.forEach((acc) => {
    const west = bbox[0] + acc.minCol * pxLon;
    const east = bbox[0] + (acc.maxCol + 1) * pxLon;
    const north = bbox[3] - acc.minRow * pxLat;
    const south = bbox[3] - (acc.maxRow + 1) * pxLat;

    let tehsilName: string | null = null;
    let bestZ = -1;
    let bestCount = -1;
    acc.zoneCounts.forEach((n, z) => {
      if (n > bestCount) {
        bestCount = n;
        bestZ = z;
      }
    });
    if (bestZ > 0 && zoneMeta?.[bestZ - 1]) tehsilName = zoneMeta[bestZ - 1].name;

    hotspots.push({
      centroid: pixelToLngLat((acc.minCol + acc.maxCol) / 2, (acc.minRow + acc.maxRow) / 2, grid),
      bbox: [west, south, east, north],
      areaHa: acc.count * pxAreaHa,
      classCode: acc.classCode,
      classLabel: classLabel(acc.classCode),
      tehsilName,
    });
  });

  hotspots.sort((a, b) => b.areaHa - a.areaHa);
  return hotspots.slice(0, 10);
}
