/**
 * Validation core — pure functions, no I/O, no third-party deps.
 *
 * Compares a reference GeoJSON (human-drawn labels) with a prediction GeoJSON
 * (our engine's vector output) on a shared raster grid, then reports per-class
 * precision / recall / F1 / IoU, a confusion matrix and per-class area error.
 *
 * Reference vocabulary (properties.cls on reference features):
 *   water_gain | water_loss | veg_gain | veg_loss | builtup_increase |
 *   bare_agri | no_change
 *
 * Prediction features are read from properties in this order:
 *   1. properties.cls  (string, snake_case; aliases accepted — builtup_gain,
 *      bare_built … all map to builtup_increase)
 *   2. properties.classCode (engine codes: 0..5, 6/255 ignored)
 *   3. properties.classLabel (human label, matched case-insensitively)
 * A bare/built prediction carrying sub-label bare_agri (harvest/tillage on
 * cropland) scores as its own class, so the fused engine's sub-labels can be
 * validated per class.
 * Pixels with no prediction polygon count as `no_change` (the engine emits
 * change objects only).
 *
 * Pixels outside every reference polygon are UNLABELED and excluded from all
 * metrics (label `no_change` explicitly where you verified nothing changed).
 */

export type RefClass =
  | "water_gain"
  | "water_loss"
  | "veg_gain"
  | "veg_loss"
  | "builtup_increase"
  | "bare_agri"
  | "no_change";

export const REF_CLASSES: RefClass[] = [
  "water_gain",
  "water_loss",
  "veg_gain",
  "veg_loss",
  "builtup_increase",
  "bare_agri",
  "no_change",
];

export type LonLat = [number, number];

export interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

export interface GeoJsonFeature {
  type: "Feature";
  properties?: Record<string, unknown> | null;
  geometry: GeoJsonGeometry | null;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

export type ClassGrid = Uint8Array; // REF_CLASSES index, or 255 = unlabeled/no pixel

const UNLABELED = 255;

export interface RasterSpec {
  width: number;
  height: number;
  bbox: [number, number, number, number]; // west, south, east, north
  pxLon: number;
  pxLat: number;
  pxAreaHa: number; // equirectangular area at mid latitude, like grid.ts
}

export interface ValidationCase {
  name: string;
  reference: GeoJsonFeatureCollection;
  prediction: GeoJsonFeatureCollection;
  /** Optional provenance for the report. */
  meta?: { dateA?: string; dateB?: string; engine?: string; rules?: string };
}

export interface ClassMetrics {
  cls: RefClass;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null; // null when undefined (no predicted/positive pixels)
  recall: number | null;
  f1: number | null;
  iou: number | null;
  areaHaReference: number;
  areaHaPredicted: number;
  areaErrorPct: number | null; // (pred - ref) / ref, null when ref = 0
}

export interface CaseReport {
  name: string;
  width: number;
  height: number;
  labeledFraction: number; // labeled px / total px
  labeledPx: number;
  confusion: number[][]; // [refIdx][predIdx]
  metrics: ClassMetrics[];
  overallAccuracy: number; // on labeled pixels
  macroF1: number | null; // mean F1 over classes with support > 0
  changeF1: number | null; // binary: any change class vs no_change
  meta?: ValidationCase["meta"];
}

/* ------------------------------------------------------------------ */
/* class mapping                                                       */
/* ------------------------------------------------------------------ */

const ALIASES: Record<string, RefClass> = {
  water_gain: "water_gain",
  watergain: "water_gain",
  water_loss: "water_loss",
  waterloss: "water_loss",
  veg_gain: "veg_gain",
  vegetation_gain: "veg_gain",
  vegloss: "veg_loss",
  veg_loss: "veg_loss",
  vegetation_loss: "veg_loss",
  builtup_increase: "builtup_increase",
  builtup_gain: "builtup_increase",
  builtup: "builtup_increase",
  builtup_bare_increase: "builtup_increase",
  bare_built: "builtup_increase",
  barebuilt: "builtup_increase",
  /** Engine classLabel for code 3: "Bare / built-up increase". */
  barebuiltincrease: "builtup_increase",
  bare_agri: "bare_agri",
  bareagri: "bare_agri",
  bare_agriculture: "bare_agri",
  agri_bare: "bare_agri",
  no_change: "no_change",
  nochang: "no_change",
  nochchange: "no_change",
};

/** Alias keys with underscores removed — for human classLabel matching
 *  ("Built-up increase" → "builtupincrease"). */
const ALIASES_NORM: Record<string, RefClass> = Object.fromEntries(
  Object.entries(ALIASES).map(([k, v]) => [k.replace(/_/g, ""), v]),
);

const CLASS_CODE_MAP: Record<number, RefClass> = {
  0: "no_change",
  1: "veg_gain",
  2: "veg_loss",
  3: "builtup_increase",
  4: "water_gain",
  5: "water_loss",
};

/** Bare/built patch tagged as agri-bare (harvest/tillage on cropland). */
function subIsBareAgri(props: Record<string, unknown>): boolean {
  const raw =
    typeof props.sub_label === "string"
      ? props.sub_label
      : typeof props.subLabel === "string"
        ? props.subLabel
        : typeof props.sub === "string"
          ? props.sub
          : null;
  if (!raw) return false;
  const norm = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
  // Alias vocabulary ("bare_agri", "agri_bare") or the engine's full sub-label
  // text (SUB_LABELS[bareBuiltAgriculture] = "Bare soil on cropland (likely
  // harvest / tillage)"). Only ever called for builtup_increase predictions,
  // so matching "cropland"/"tillage"/"harvest" cannot collide with the veg
  // sub-labels (those sit on veg_gain/veg_loss classes, never checked here).
  if (norm.includes("bareagri") || norm.includes("agribare")) return true;
  return (
    norm.includes("bare") &&
    (norm.includes("cropland") || norm.includes("tillage") || norm.includes("harvest"))
  );
}

/** Returns the reference class for a feature, or null when not mappable (masked/outside). */
export function featureClass(feature: GeoJsonFeature): RefClass | null {
  const props = feature.properties ?? {};
  const cls = typeof props.cls === "string" ? props.cls.trim().toLowerCase() : null;
  let base: RefClass | null = null;
  if (cls) {
    base = ALIASES[cls] ?? null;
    if (!base && (cls === "masked" || cls === "outside" || cls === "unknown")) return null;
  }
  if (!base && typeof props.classCode === "number") {
    base = CLASS_CODE_MAP[props.classCode] ?? null;
  }
  if (!base && typeof props.classLabel === "string") {
    const key = props.classLabel.trim().toLowerCase().replace(/[^a-z]/g, "");
    base = ALIASES_NORM[key] ?? null;
  }
  if (!base) return null;
  if (base === "builtup_increase" && subIsBareAgri(props)) return "bare_agri";
  return base;
}

export function classIndex(cls: RefClass): number {
  return REF_CLASSES.indexOf(cls);
}

/* ------------------------------------------------------------------ */
/* rasterization                                                       */
/* ------------------------------------------------------------------ */

function unionBbox(collections: GeoJsonFeatureCollection[]): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (geom: GeoJsonGeometry): void => {
    const walk = (coords: unknown): void => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        const [x, y] = coords as LonLat;
        if (x < west) west = x;
        if (y < south) south = y;
        if (x > east) east = x;
        if (y > north) north = y;
        return;
      }
      for (const child of coords) walk(child);
    };
    walk(geom.coordinates);
  };
  for (const fc of collections) {
    for (const f of fc.features) if (f.geometry) visit(f.geometry);
  }
  if (!Number.isFinite(west)) throw new Error("unionBbox: no coordinates in inputs");
  return [west, south, east, north];
}

/** Builds the shared grid. `targetPx` is the long side in pixels (min 64). */
export function buildRaster(
  reference: GeoJsonFeatureCollection,
  prediction: GeoJsonFeatureCollection,
  targetPx = 400,
): RasterSpec {
  const [w0, s0, e0, n0] = unionBbox([reference, prediction]);
  const padX = Math.max((e0 - w0) * 0.02, 1e-6);
  const padY = Math.max((n0 - s0) * 0.02, 1e-6);
  const bbox: [number, number, number, number] = [w0 - padX, s0 - padY, e0 + padX, n0 + padY];
  const [west, south, east, north] = bbox;
  const lonSpan = east - west;
  const latSpan = north - south;
  const longSide = Math.max(64, Math.round(targetPx));
  let width: number;
  let height: number;
  if (lonSpan >= latSpan) {
    width = longSide;
    height = Math.max(1, Math.round((latSpan / lonSpan) * longSide));
  } else {
    height = longSide;
    width = Math.max(1, Math.round((lonSpan / latSpan) * longSide));
  }
  const pxLon = lonSpan / width;
  const pxLat = latSpan / height;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const metersX = pxLon * 111_320 * Math.cos(midLatRad);
  const metersY = pxLat * 110_574;
  const pxAreaHa = (metersX * metersY) / 10_000;
  return { width, height, bbox, pxLon, pxLat, pxAreaHa };
}

type Ring = LonLat[];

function geometryToRings(geom: GeoJsonGeometry): Ring[] {
  const rings: Ring[] = [];
  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates as Ring[]) rings.push(ring);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates as Ring[][]) {
      for (const ring of poly) rings.push(ring);
    }
  }
  // Lines / points / collections carry no area — skipped.
  return rings;
}

/**
 * Rasterizes features onto the grid using a scanline even-odd fill at pixel
 * centres. Later features overwrite earlier ones (file order, documented in
 * validation/README.md). Returns { values, filled } where filled = px has a feature.
 */
export function rasterize(
  collection: GeoJsonFeatureCollection,
  spec: RasterSpec,
  resolve: (feature: GeoJsonFeature) => number | null,
): { values: ClassGrid; filled: Uint8Array } {
  const { width, height, bbox, pxLon, pxLat } = spec;
  const [west, , , north] = bbox;
  const values = new Uint8Array(width * height).fill(UNLABELED);
  const filled = new Uint8Array(width * height);

  for (const feature of collection.features) {
    if (!feature.geometry) continue;
    const code = resolve(feature);
    if (code === null) continue;
    const rings = geometryToRings(feature.geometry);
    if (rings.length === 0) continue;

    // Bounding rows/cols of the feature (pixel-centre conservative bounds).
    let minRow = height;
    let maxRow = -1;
    let minCol = width;
    let maxCol = -1;
    for (const ring of rings) {
      for (const [x, y] of ring) {
        const col = Math.floor((x - west) / pxLon);
        const row = Math.floor((north - y) / pxLat);
        if (row < 0 || row >= height || col < 0 || col >= width) continue;
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
      }
    }
    if (maxRow < minRow || maxCol < minCol) continue;
    minRow = Math.max(0, minRow - 1);
    maxRow = Math.min(height - 1, maxRow + 1);
    minCol = Math.max(0, minCol - 1);
    maxCol = Math.min(width - 1, maxCol + 1);

    for (let row = minRow; row <= maxRow; row += 1) {
      const y = north - (row + 0.5) * pxLat;
      // Gather even-odd crossings across all rings of this feature.
      const crossings: number[] = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i += 1) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[(i + 1) % ring.length];
          if (y1 === y2) continue;
          const below1 = y1 > y;
          const below2 = y2 > y;
          if (below1 === below2) continue;
          const t = (y - y1) / (y2 - y1);
          crossings.push(x1 + t * (x2 - x1));
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const xa = crossings[k];
        const xb = crossings[k + 1];
        // First col whose centre >= xa, last col whose centre <= xb.
        const colStart = Math.max(minCol, Math.ceil((xa - west) / pxLon - 0.5));
        const colEnd = Math.min(maxCol, Math.floor((xb - west) / pxLon - 0.5));
        for (let col = colStart; col <= colEnd; col += 1) {
          const idx = row * width + col;
          values[idx] = code;
          filled[idx] = 1;
        }
      }
    }
  }
  return { values, filled };
}

/* ------------------------------------------------------------------ */
/* metrics                                                             */
/* ------------------------------------------------------------------ */

export function confusionMatrix(
  reference: ClassGrid,
  prediction: ClassGrid,
  spec: RasterSpec,
): { confusion: number[][]; labeledPx: number; labeledFraction: number } {
  const n = REF_CLASSES.length;
  const confusion = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let labeled = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const r = reference[i];
    if (r === UNLABELED) continue;
    const p = prediction[i];
    if (p === UNLABELED) continue; // prediction always fills; guard anyway
    confusion[r][p] += 1;
    labeled += 1;
  }
  return {
    confusion,
    labeledPx: labeled,
    labeledFraction: labeled / (spec.width * spec.height),
  };
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export function computeMetrics(confusion: number[][], pxAreaHa: number): ClassMetrics[] {
  const n = REF_CLASSES.length;
  return REF_CLASSES.map((cls, i) => {
    const tp = confusion[i][i];
    let rowTotal = 0;
    for (let j = 0; j < n; j += 1) rowTotal += confusion[i][j];
    let colTotal = 0;
    for (let r = 0; r < n; r += 1) colTotal += confusion[r][i];
    const fn = rowTotal - tp;
    const fp = colTotal - tp;
    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, tp + fn);
    const f1 =
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall);
    const iou = ratio(tp, tp + fp + fn);
    const refPx = tp + fn;
    const predPx = tp + fp;
    return {
      cls,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
      iou,
      areaHaReference: refPx * pxAreaHa,
      areaHaPredicted: predPx * pxAreaHa,
      areaErrorPct: refPx === 0 ? null : (predPx - refPx) / refPx,
    };
  });
}

export function overallAccuracy(confusion: number[][]): number {
  let correct = 0;
  let total = 0;
  for (let i = 0; i < confusion.length; i += 1) {
    for (let j = 0; j < confusion[i].length; j += 1) {
      total += confusion[i][j];
      if (i === j) correct += confusion[i][j];
    }
  }
  return total === 0 ? 0 : correct / total;
}

/** Macro F1 over classes that have at least one reference pixel (support > 0). */
export function macroF1(metrics: ClassMetrics[]): number | null {
  const withSupport = metrics.filter((m) => m.tp + m.fn > 0 && m.f1 !== null);
  if (withSupport.length === 0) return null;
  const sum = withSupport.reduce((acc, m) => acc + (m.f1 as number), 0);
  return sum / withSupport.length;
}

/** Binary change-vs-no_change hit/miss counts from a confusion matrix. */
export function binaryChange(confusion: number[][]): { tp: number; fp: number; fn: number } | null {
  const n = REF_CLASSES.length;
  const noChangeIdx = classIndex("no_change");
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let r = 0; r < n; r += 1) {
    for (let p = 0; p < n; p += 1) {
      const v = confusion[r][p];
      const refChange = r !== noChangeIdx;
      const predChange = p !== noChangeIdx;
      if (refChange && predChange) tp += v;
      else if (!refChange && predChange) fp += v;
      else if (refChange && !predChange) fn += v;
    }
  }
  if (tp + fp + fn === 0) return null;
  return { tp, fp, fn };
}

export function f1From(tp: number, fp: number, fn: number): number | null {
  if (tp + fp === 0 || tp + fn === 0) return null;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  if (precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

/** Runs the full pipeline for one case. */
export function validateCase(item: ValidationCase, targetPx = 400): CaseReport {
  const spec = buildRaster(item.reference, item.prediction, targetPx);
  const ref = rasterize(item.reference, spec, (f) => {
    const cls = featureClass(f);
    return cls === null ? null : classIndex(cls);
  });
  const pred = rasterize(item.prediction, spec, (f) => {
    const cls = featureClass(f);
    return cls === null ? null : classIndex(cls);
  });
  // Unfilled prediction pixels = no_change (engine emits change objects only).
  for (let i = 0; i < pred.values.length; i += 1) {
    if (!pred.filled[i]) pred.values[i] = classIndex("no_change");
  }
  const { confusion, labeledPx, labeledFraction } = confusionMatrix(
    ref.values,
    pred.values,
    spec,
  );
  const metrics = computeMetrics(confusion, spec.pxAreaHa);
  const binary = binaryChange(confusion);
  return {
    name: item.name,
    width: spec.width,
    height: spec.height,
    labeledFraction,
    labeledPx,
    confusion,
    metrics,
    overallAccuracy: overallAccuracy(confusion),
    macroF1: macroF1(metrics),
    changeF1: binary ? f1From(binary.tp, binary.fp, binary.fn) : null,
    meta: item.meta,
  };
}

/** Sums confusion matrices of several cases (for the aggregate row). */
export function aggregateConfusion(reports: CaseReport[]): number[][] {
  const n = REF_CLASSES.length;
  const total = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const report of reports) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) total[i][j] += report.confusion[i][j];
    }
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* report rendering (markdown)                                         */
/* ------------------------------------------------------------------ */

function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function area(value: number): string {
  if (value >= 1000) return `${value.toFixed(0)} ha`;
  if (value >= 1) return `${value.toFixed(2)} ha`;
  return `${value.toFixed(4)} ha`;
}

/** Per-class table. `unit="px"` prints raw pixel counts for the mixed-grid aggregate row. */
function classTable(metrics: ClassMetrics[], unit: "ha" | "px" = "ha"): string {
  const head =
    unit === "ha"
      ? "| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |"
      : "| Class | Precision | Recall | F1 | IoU | Ref px | Pred px | Area error |";
  const sep = "|---|---|---|---|---|---|---|---|";
  const rows = metrics.map((m) => {
    const err = m.areaErrorPct === null ? "—" : `${(m.areaErrorPct * 100).toFixed(1)}%`;
    const refArea =
      unit === "ha" ? area(m.areaHaReference) : `${Math.round(m.areaHaReference)} px`;
    const predArea =
      unit === "ha" ? area(m.areaHaPredicted) : `${Math.round(m.areaHaPredicted)} px`;
    return `| ${m.cls} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${pct(m.iou)} | ${refArea} | ${predArea} | ${err} |`;
  });
  return [head, sep, ...rows].join("\n");
}

function confusionTable(confusion: number[][]): string {
  const head = `| ref \\ pred | ${REF_CLASSES.join(" | ")} |`;
  const sep = `|---|${REF_CLASSES.map(() => "---").join("|")}|`;
  const rows = confusion.map(
    (row, i) => `| **${REF_CLASSES[i]}** | ${row.map((v) => String(v)).join(" | ")} |`,
  );
  return [head, sep, ...rows].join("\n");
}

export interface ReportOptions {
  engine: string;
  generatedAt?: string;
  targetPx: number;
  note?: string;
}

export function renderMarkdownReport(reports: CaseReport[], options: ReportOptions): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const aggregate = aggregateConfusion(reports);
  const aggregateMetrics = computeMetrics(
    aggregate,
    // area columns in the aggregate row are px-based on mixed grids; keep px counts only
    1,
  );
  const binary = binaryChange(aggregate);
  const lines: string[] = [];
  lines.push(`# Validation report — engine ${options.engine}`);
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Cases: ${reports.length}`);
  lines.push(`- Raster grid long side: ${options.targetPx} px`);
  if (options.note) lines.push(`- Note: ${options.note}`);
  lines.push("");
  lines.push(
    "> Metrics are computed on **labeled pixels only** (inside some reference polygon).",
  );
  lines.push(
    "> Pixels without a prediction polygon count as `no_change` (the engine emits change objects only).",
  );
  lines.push("");
  lines.push("## Aggregate (all cases, summed confusion)");
  lines.push("");
  lines.push(`- Overall accuracy: **${pct(overallAccuracy(aggregate))}**`);
  lines.push(`- Macro F1 (support > 0): **${pct(macroF1(aggregateMetrics))}**`);
  lines.push(
    `- Change-vs-no_change F1: **${binary ? pct(f1From(binary.tp, binary.fp, binary.fn)) : "—"}**`,
  );
  lines.push("");
  lines.push(classTable(aggregateMetrics, "px"));
  lines.push("");
  lines.push(confusionTable(aggregate));
  lines.push("");

  for (const report of reports) {
    lines.push(`## Case: ${report.name}`);
    if (report.meta?.dateA && report.meta?.dateB) {
      lines.push(`- Dates: ${report.meta.dateA} → ${report.meta.dateB}`);
    }
    lines.push(`- Grid: ${report.width}×${report.height} px, labeled ${(report.labeledFraction * 100).toFixed(1)}% of extent`);
    lines.push(`- Overall accuracy: ${pct(report.overallAccuracy)}, Macro F1: ${pct(report.macroF1)}, Change F1: ${pct(report.changeF1)}`);
    lines.push("");
    lines.push(classTable(report.metrics));
    lines.push("");
    lines.push(confusionTable(report.confusion));
    lines.push("");
  }
  return lines.join("\n");
}
