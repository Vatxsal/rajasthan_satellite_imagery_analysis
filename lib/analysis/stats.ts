/**
 * Deterministic statistics from the classified raster: per-class areas,
 * valid-data share, tehsil zonal breakdown (district level) and top hotspots.
 * These numbers are the single source of truth for the UI *and* the AI
 * summary — the model never computes anything itself.
 */
import { CLASS, CLASS_DEFS, M2_PER_HA, PATCH_VECTOR_LIMIT, SUB, classLabel, subLabel } from "./config";
import { eventId } from "./events";
import { pixelEdgesToBbox, pixelToLngLat } from "./mask";
import { patchToMultiPolygon } from "./polygon";
import { PERSIST, TIER } from "./v2/classify";
import type {
  AnalysisGrid,
  ClassStat,
  CompareStats,
  ConfidenceTier,
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
  /** v2 TIER codes per pixel; null for v1 (no confidence data). */
  tiers?: Uint8Array | null;
  /** v2 SUB codes per pixel; null for v1. */
  subs?: Uint8Array | null;
  /** v2 PERSIST codes per pixel; null for v1. */
  persist?: Uint8Array | null;
  /** v2 short-gap flag for vegetation confidence tags (§2.6). */
  shortGap?: boolean;
}

const TIER_TEXT: Record<number, ConfidenceTier> = {
  [TIER.low]: "low",
  [TIER.medium]: "medium",
  [TIER.high]: "high",
};

/** SUB codes that mark a seasonal crop cycle (patch tag "crop-cycle"). */
const CROP_SUBS = new Set<number>([SUB.vegLossHarvest, SUB.vegGainSeasonal]);

export function computeStats(args: ComputeStatsArgs): CompareStatsCore {
  const { classGrid, labels, grid, zones, zoneMeta, tiers, subs, persist, shortGap } = args;
  const pxAreaHa = (grid.metersX * grid.metersY) / M2_PER_HA;
  const counts = new Uint32Array(256);
  const tierCounts = { high: 0, medium: 0, low: 0 };
  let insidePixels = 0;
  // Change-pixel extent → stats.changeBbox (drives "Zoom to changes").
  let changedMinCol = -1;
  let changedMaxCol = -1;
  let changedMinRow = -1;
  let changedMaxRow = -1;

  for (let i = 0; i < classGrid.length; i++) {
    const code = classGrid[i];
    if (code === CLASS.outside) continue;
    insidePixels += 1;
    counts[code] += 1;
    if (code >= CLASS.vegGain && code <= CLASS.waterLoss) {
      if (tiers) {
        // Change pixels always carry a tier; imputed pixels fall back to low.
        const tierText = TIER_TEXT[tiers[i]] ?? "low";
        tierCounts[tierText] += 1;
      }
      const col = i % grid.width;
      const row = (i - col) / grid.width;
      if (changedMinCol < 0 || col < changedMinCol) changedMinCol = col;
      if (col > changedMaxCol) changedMaxCol = col;
      if (changedMinRow < 0 || row < changedMinRow) changedMinRow = row;
      if (row > changedMaxRow) changedMaxRow = row;
    }
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
    changeBbox:
      changedMinCol >= 0
        ? [
            grid.bbox[0] + changedMinCol * grid.pxLon,
            grid.bbox[3] - (changedMaxRow + 1) * grid.pxLat,
            grid.bbox[0] + (changedMaxCol + 1) * grid.pxLon,
            grid.bbox[3] - changedMinRow * grid.pxLat,
          ]
        : null,
    negligible: changedPixels === 0,
    ...(tiers ? { confidence: tierCounts } : {}),
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

  stats.hotspots = computeHotspots(classGrid, labels, grid, zones ?? null, zoneMeta ?? null, pxAreaHa, {
    tiers: tiers ?? null,
    subs: subs ?? null,
    persist: persist ?? null,
    shortGap: shortGap ?? false,
  });
  return stats;
}

interface PatchAcc {
  label: number;
  count: number;
  classCode: number;
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
  zoneCounts: Map<number, number>;
  /** v2 tier counts [low, medium, high] over the patch pixels. */
  tierCounts: [number, number, number];
  /** v2 sub-code counts over the patch pixels. */
  subCounts: Map<number, number>;
  /** v2 persistence counts [yes, transient]. */
  persistCounts: [number, number];
}

export interface AuxGrids {
  tiers: Uint8Array | null;
  subs: Uint8Array | null;
  persist: Uint8Array | null;
  shortGap: boolean;
}

/** Majority tier over a patch; ties resolve to the conservative (lower) tier. */
function majorityTier(counts: [number, number, number]): ConfidenceTier {
  const [nLow, nMed, nHigh] = counts;
  let bestTier = 1;
  let bestN = nLow;
  if (nMed > bestN) {
    bestTier = 2;
    bestN = nMed;
  }
  if (nHigh > bestN) bestTier = 3;
  return TIER_TEXT[bestTier] ?? "low";
}

/**
 * Majority SUB code over a patch (filtered to the patch's class — stale codes
 * survive majority flips); ties resolve to the lower code; 0 = "no sub-label".
 * Shared by computeHotspots and buildPatchVectors so hotspots and events agree.
 */
function majoritySub(subCounts: Map<number, number>, classCode: number): number {
  let subBest = 0;
  let subN = 0;
  subCounts.forEach((count, sub) => {
    if (Math.floor(sub / 10) !== classCode) return; // stale after majority flip
    if (count > subN || (count === subN && (subBest === 0 || sub < subBest))) {
      subBest = sub;
      subN = count;
    }
  });
  return subBest;
}

/** Majority zone (tehsil) name over a patch; null outside district level. */
function majorityZoneName(zoneCounts: Map<number, number>, zoneMeta: ZoneMeta[] | null): string | null {
  let bestZ = -1;
  let bestCount = -1;
  zoneCounts.forEach((n, z) => {
    if (n > bestCount) {
      bestCount = n;
      bestZ = z;
    }
  });
  if (bestZ > 0 && zoneMeta?.[bestZ - 1]) return zoneMeta[bestZ - 1].name;
  return null;
}

/** v2 evidence tags for a patch: transient / crop-cycle / short-gap. */
function patchTags(input: {
  classCode: number;
  subBest: number;
  persistCounts: [number, number];
  shortGap: boolean;
}): string[] {
  const tags: string[] = [];
  if (input.persistCounts[1] > input.persistCounts[0] && input.persistCounts[1] > 0) {
    tags.push("transient");
  }
  if (input.subBest !== 0 && CROP_SUBS.has(input.subBest)) tags.push("crop-cycle");
  if (input.shortGap && (input.classCode === CLASS.vegLoss || input.classCode === CLASS.vegGain)) {
    tags.push("short-gap");
  }
  return tags;
}

function computeHotspots(
  classGrid: Uint8Array,
  labels: Int32Array,
  grid: AnalysisGrid,
  zones: Int16Array | null,
  zoneMeta: ZoneMeta[] | null,
  pxAreaHa: number,
  aux: AuxGrids,
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
        label,
        count: 0,
        classCode: classGrid[i],
        minCol: col,
        maxCol: col,
        minRow: row,
        maxRow: row,
        zoneCounts: new Map(),
        tierCounts: [0, 0, 0],
        subCounts: new Map(),
        persistCounts: [0, 0],
      };
      patches.set(label, acc);
    }
    acc.count += 1;
    if (aux.tiers) {
      const tier = aux.tiers[i];
      if (tier >= TIER.low && tier <= TIER.high) acc.tierCounts[tier - 1] += 1;
    }
    if (aux.subs && aux.subs[i] !== 0) {
      const sub = aux.subs[i];
      acc.subCounts.set(sub, (acc.subCounts.get(sub) ?? 0) + 1);
    }
    if (aux.persist) {
      if (aux.persist[i] === PERSIST.yes) acc.persistCounts[0] += 1;
      else if (aux.persist[i] === PERSIST.transient) acc.persistCounts[1] += 1;
    }
    if (col < acc.minCol) acc.minCol = col;
    if (col > acc.maxCol) acc.maxCol = col;
    if (row < acc.minRow) acc.minRow = row;
    if (row > acc.maxRow) acc.maxRow = row;
    if (zones) {
      const z = zones[i];
      if (z > 0) acc.zoneCounts.set(z, (acc.zoneCounts.get(z) ?? 0) + 1);
    }
  }

  const top = Array.from(patches.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (top.length === 0) return [];

  // One pass over the label raster collects the pixels of the top patches
  // (the polygons are only needed for those 10).
  const wanted = new Set<number>();
  for (const acc of top) wanted.add(acc.label);
  const pixelsByLabel = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0 || !wanted.has(label)) continue;
    let list = pixelsByLabel.get(label);
    if (!list) {
      list = [];
      pixelsByLabel.set(label, list);
    }
    list.push(i);
  }

  const hotspots: Hotspot[] = top.map((acc) => {
    const west = bbox[0] + acc.minCol * pxLon;
    const east = bbox[0] + (acc.maxCol + 1) * pxLon;
    const north = bbox[3] - acc.minRow * pxLat;
    const south = bbox[3] - (acc.maxRow + 1) * pxLat;

    const tehsilName = majorityZoneName(acc.zoneCounts, zoneMeta);
    const pixels = pixelsByLabel.get(acc.label) ?? [];

    // v2 confidence/sub-label/tags: majorities over the patch pixels. Ties in
    // tier resolve to the conservative (lower) tier; sub ties to the lower code.
    let confidence: ConfidenceTier | undefined;
    let subText: string | null | undefined;
    let tags: string[] | undefined;
    if (aux.tiers || aux.subs) {
      confidence = majorityTier(acc.tierCounts);
      const subBest = majoritySub(acc.subCounts, acc.classCode);
      subText = subBest === 0 ? null : subLabel(subBest);
      tags = patchTags({
        classCode: acc.classCode,
        subBest,
        persistCounts: acc.persistCounts,
        shortGap: aux.shortGap,
      });
    }

    return {
      centroid: pixelToLngLat((acc.minCol + acc.maxCol) / 2, (acc.minRow + acc.maxRow) / 2, grid),
      bbox: [west, south, east, north],
      areaHa: acc.count * pxAreaHa,
      classCode: acc.classCode,
      classLabel: classLabel(acc.classCode),
      tehsilName,
      polygon: patchToMultiPolygon(pixels, width, grid),
      ...(confidence ? { confidence } : {}),
      ...(subText !== undefined ? { subLabel: subText } : {}),
      ...(tags ? { tags } : {}),
    };
  });

  return hotspots;
}

/**
 * Phase 5 (#13) — full-coverage vector layer: every kept change patch
 * (largest first, capped at `limit`) as a GeoJSON Feature. The client-facing
 * stats still carry only the top-10 hotspots; this collection lives on the
 * CompareArtifact and feeds the events/export pipeline (Phase 6).
 */
export function buildPatchVectors(
  classGrid: Uint8Array,
  labels: Int32Array,
  grid: AnalysisGrid,
  pxAreaHa: number,
  aux: AuxGrids,
  limit: number = PATCH_VECTOR_LIMIT,
  /** Zone index+1 per pixel (rasterizeZones); null outside district level —
   *  gives every event its tehsilName like the hotspots already carry. */
  zones: Int16Array | null = null,
  zoneMeta: ZoneMeta[] | null = null,
): GeoJSON.FeatureCollection {
  const { width } = grid;
  const patches = new Map<
    number,
    {
      label: number;
      count: number;
      classCode: number;
      tierCounts: [number, number, number];
      zoneCounts: Map<number, number>;
      subCounts: Map<number, number>;
      persistCounts: [number, number];
    }
  >();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0) continue;
    let acc = patches.get(label);
    if (!acc) {
      acc = {
        label,
        count: 0,
        classCode: classGrid[i],
        tierCounts: [0, 0, 0],
        zoneCounts: new Map(),
        subCounts: new Map(),
        persistCounts: [0, 0],
      };
      patches.set(label, acc);
    }
    acc.count += 1;
    if (aux.tiers) {
      const tier = aux.tiers[i];
      if (tier >= TIER.low && tier <= TIER.high) acc.tierCounts[tier - 1] += 1;
    }
    if (aux.subs && aux.subs[i] !== 0) {
      const sub = aux.subs[i];
      acc.subCounts.set(sub, (acc.subCounts.get(sub) ?? 0) + 1);
    }
    if (aux.persist) {
      if (aux.persist[i] === PERSIST.yes) acc.persistCounts[0] += 1;
      else if (aux.persist[i] === PERSIST.transient) acc.persistCounts[1] += 1;
    }
    if (zones) {
      const z = zones[i];
      if (z > 0) acc.zoneCounts.set(z, (acc.zoneCounts.get(z) ?? 0) + 1);
    }
  }

  const kept = Array.from(patches.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  if (kept.length === 0) return { type: "FeatureCollection", features: [] };

  // One pass over the label raster collects the pixels of the kept patches.
  const wanted = new Set(kept.map((k) => k.label));
  const pixelsByLabel = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0 || !wanted.has(label)) continue;
    let list = pixelsByLabel.get(label);
    if (!list) {
      list = [];
      pixelsByLabel.set(label, list);
    }
    list.push(i);
  }

  const features: GeoJSON.Feature[] = [];
  for (const acc of kept) {
    const pixels = pixelsByLabel.get(acc.label) ?? [];
    if (pixels.length === 0) continue;
    const geometry = patchToMultiPolygon(pixels, width, grid);
    if (!geometry) continue;
    // Patch bbox centre (same convention as hotspots; may fall outside an L).
    let minCol = width;
    let maxCol = 0;
    let minRow = grid.height;
    let maxRow = 0;
    for (const i of pixels) {
      const col = i % width;
      const row = Math.floor(i / width);
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
    // Same availability rule as computeHotspots: v2 evidence fields exist
    // whenever tier or sub grids are present, so hotspots and events agree.
    let confidence: ConfidenceTier | undefined;
    let subText: string | null | undefined;
    let tags: string[] | undefined;
    if (aux.tiers || aux.subs) {
      confidence = majorityTier(acc.tierCounts);
      const subBest = majoritySub(acc.subCounts, acc.classCode);
      subText = subBest === 0 ? null : subLabel(subBest);
      tags = patchTags({
        classCode: acc.classCode,
        subBest,
        persistCounts: acc.persistCounts,
        shortGap: aux.shortGap,
      });
    }
    const tehsilName = majorityZoneName(acc.zoneCounts, zoneMeta);

    const centroid = pixelToLngLat((minCol + maxCol) / 2, (minRow + maxRow) / 2, grid);
    // Outer edges of the first/last patch pixel — event bbox for map focusing.
    const topLeft = pixelEdgesToBbox(minCol, minRow, grid);
    const bottomRight = pixelEdgesToBbox(maxCol, maxRow, grid);
    const bbox: [number, number, number, number] = [
      topLeft[0],
      bottomRight[1],
      bottomRight[2],
      topLeft[3],
    ];
    const areaHa = Math.round(acc.count * pxAreaHa * 100) / 100;
    // #16: stable event id — GeoJSON Feature.id plus a copy in properties.
    const id = eventId(acc.classCode, acc.label, centroid, areaHa);
    features.push({
      type: "Feature",
      id,
      geometry,
      properties: {
        id,
        label: acc.label,
        classCode: acc.classCode,
        classLabel: classLabel(acc.classCode),
        areaHa,
        centroid,
        bbox,
        ...(confidence ? { confidence } : {}),
        ...(subText !== undefined ? { subLabel: subText } : {}),
        ...(tags ? { tags } : {}),
        ...(tehsilName ? { tehsilName } : {}),
      },
    });
  }
  return { type: "FeatureCollection", features };
}
