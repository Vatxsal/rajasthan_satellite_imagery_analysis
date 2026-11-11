/**
 * Fields & cropping-pattern validation — pure metrics, no I/O, no third-party deps.
 *
 * Scores a reference field labelling (QGIS, see validation/README.md) against
 * our fields + pattern output for the same extent on a shared raster grid:
 *
 *   1. Field mask      — binary IoU / precision / recall / F1 (field vs no_field).
 *   2. Boundary MCC    — Matthews correlation coefficient between the two
 *                        boundary bands (each boundary dilated by `tolerancePx`),
 *                        so geometry quality is scored near the edges instead of
 *                        being drowned in true negatives.
 *   3. Pattern classes — (N+1)×(N+1) confusion matrix (N pattern classes +
 *                        `no_field`), per-class precision / recall / F1 / IoU
 *                        and area error, plus macro F1 over supported classes.
 *
 * Reference vocabulary: `properties.cls` must be one of PATTERN_CLASSES
 * (lib/fields/config.ts). A missing `cls` scores as `unclassified` (boundary-only
 * labels); an unknown `cls` value drops the feature. Unlike the change harness,
 * everything OUTSIDE a reference field is `no_field` — a true negative. Field
 * segmentation needs negatives to score precision, so there is no unlabelled
 * exclusion zone here.
 */
import {
  buildRaster,
  rasterize,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
} from "./engine";
import { PATTERN_CLASSES, type PatternClass } from "../lib/fields/config";

/** Grid value for "no field on this side" (the `no_field` confusion class). */
export const FIELD_NONE = PATTERN_CLASSES.length;
/** Class names in confusion order: the N pattern classes, then `no_field`. */
export const FIELD_CLASS_NAMES: readonly string[] = [...PATTERN_CLASSES, "no_field"];

/** Grid value: PATTERN_CLASSES index for a field pixel, FIELD_NONE otherwise. */
export type FieldGrid = Uint8Array;

export interface FieldsCase {
  name: string;
  reference: GeoJsonFeatureCollection;
  prediction: GeoJsonFeatureCollection;
  meta?: { year?: number; note?: string };
}

export interface FieldMaskMetrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  iou: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface FieldClassMetrics {
  cls: PatternClass;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  iou: number | null;
  areaHaReference: number;
  areaHaPredicted: number;
  areaErrorPct: number | null;
}

export interface FieldsCaseReport {
  name: string;
  width: number;
  height: number;
  /** (N+1)×(N+1): [refClass][predClass], both axes in FIELD_CLASS_NAMES order. */
  confusion: number[][];
  mask: FieldMaskMetrics;
  boundaryMcc: number | null;
  tolerancePx: number;
  classMetrics: FieldClassMetrics[];
  macroF1: number | null;
  meta?: FieldsCase["meta"];
}

/* ------------------------------------------------------------------ */
/* class mapping                                                       */
/* ------------------------------------------------------------------ */

/**
 * Pattern class index for a feature:
 *   - `cls` present and known  → its PATTERN_CLASSES index
 *   - `cls` missing            → `unclassified` (boundary-only labels)
 *   - `cls` present, unknown   → null (feature dropped, like masked/outside)
 */
export function patternClassIndex(feature: GeoJsonFeature): number | null {
  const props = feature.properties ?? {};
  if (typeof props.cls !== "string") {
    return PATTERN_CLASSES.indexOf("unclassified");
  }
  const raw = props.cls.trim().toLowerCase();
  const idx = (PATTERN_CLASSES as readonly string[]).indexOf(raw);
  return idx >= 0 ? idx : null;
}

/* ------------------------------------------------------------------ */
/* binary masks & boundaries                                           */
/* ------------------------------------------------------------------ */

/** Field-vs-no_field mask from a class grid (1 = field pixel). */
export function binaryMaskFromGrid(grid: FieldGrid): Uint8Array {
  const mask = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i += 1) mask[i] = grid[i] === FIELD_NONE ? 0 : 1;
  return mask;
}

/** Pixels on the edge of a field region (4-neighbour; grid border counts as outside). */
export function boundaryMask(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const i = r * width + c;
      if (!mask[i]) continue;
      const up = r === 0 || !mask[i - width];
      const down = r === height - 1 || !mask[i + width];
      const left = c === 0 || !mask[i - 1];
      const right = c === width - 1 || !mask[i + 1];
      if (up || down || left || right) out[i] = 1;
    }
  }
  return out;
}

/** Chebyshev dilation of a mask by `radius` pixels (8-neighbour per pass). */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  let cur = Uint8Array.from(mask);
  for (let pass = 0; pass < radius; pass += 1) {
    const next = Uint8Array.from(cur);
    for (let i = 0; i < cur.length; i += 1) {
      if (!cur[i]) continue;
      const r = Math.floor(i / width);
      const c = i - r * width;
      for (let dr = -1; dr <= 1; dr += 1) {
        const nr = r + dr;
        if (nr < 0 || nr >= height) continue;
        for (let dc = -1; dc <= 1; dc += 1) {
          const nc = c + dc;
          if (nc < 0 || nc >= width) continue;
          next[nr * width + nc] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Matthews correlation coefficient for one boundary band comparison.
 * Positive class = "within `tolerancePx` of a boundary". Full-grid 2×2:
 * both bands → TP, pred band only → FP, ref band only → FN, neither → TN.
 * Returns null when the coefficient is undefined (degenerate denominator).
 */
export function matthewsCorrelation(tp: number, fp: number, fn: number, tn: number): number | null {
  const den = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  if (den === 0) return null;
  return (tp * tn - fp * fn) / den;
}

/** Boundary-band MCC between two field masks at a pixel tolerance. */
export function boundaryMcc(
  refMask: Uint8Array,
  predMask: Uint8Array,
  width: number,
  height: number,
  tolerancePx: number,
): number | null {
  const refBand = dilateMask(boundaryMask(refMask, width, height), width, height, tolerancePx);
  const predBand = dilateMask(boundaryMask(predMask, width, height), width, height, tolerancePx);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < refBand.length; i += 1) {
    const r = refBand[i] === 1;
    const p = predBand[i] === 1;
    if (r && p) tp += 1;
    else if (p) fp += 1;
    else if (r) fn += 1;
    else tn += 1;
  }
  return matthewsCorrelation(tp, fp, fn, tn);
}

/* ------------------------------------------------------------------ */
/* metrics from the confusion matrix                                   */
/* ------------------------------------------------------------------ */

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

/** Collapses an (N+1)×(N+1) pattern confusion into field-vs-no_field counts. */
export function collapseFieldMask(confusion: number[][]): {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
} {
  const n = confusion.length;
  const none = n - 1;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < none; i += 1) {
    for (let j = 0; j < none; j += 1) tp += confusion[i][j];
    fn += confusion[i][none];
    fp += confusion[none][i];
  }
  const tn = confusion[none][none];
  return { tp, fp, fn, tn };
}

/** Binary field-mask IoU / precision / recall / F1 from the confusion matrix. */
export function fieldMaskMetrics(confusion: number[][]): FieldMaskMetrics {
  const { tp, fp, fn, tn } = collapseFieldMask(confusion);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, tn, iou: ratio(tp, tp + fp + fn), precision, recall, f1 };
}

/** Per-class metrics for the N pattern classes (the `no_field` row/col is background). */
export function fieldClassMetrics(confusion: number[][], pxAreaHa: number): FieldClassMetrics[] {
  const n = confusion.length;
  const none = n - 1;
  return PATTERN_CLASSES.map((cls, i) => {
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
      iou: ratio(tp, tp + fp + fn),
      areaHaReference: refPx * pxAreaHa,
      areaHaPredicted: predPx * pxAreaHa,
      areaErrorPct: refPx === 0 ? null : (predPx - refPx) / refPx,
    };
  });
}

/** Macro F1 over pattern classes with reference support (tp + fn > 0). */
export function fieldMacroF1(metrics: FieldClassMetrics[]): number | null {
  const withSupport = metrics.filter((m) => m.tp + m.fn > 0 && m.f1 !== null);
  if (withSupport.length === 0) return null;
  const sum = withSupport.reduce((acc, m) => acc + (m.f1 as number), 0);
  return sum / withSupport.length;
}

/* ------------------------------------------------------------------ */
/* per-case pipeline                                                   */
/* ------------------------------------------------------------------ */

/** Runs the full field validation for one reference/prediction pair. */
export function validateFieldsCase(
  item: FieldsCase,
  targetPx = 400,
  tolerancePx = 2,
): FieldsCaseReport {
  const spec = buildRaster(item.reference, item.prediction, targetPx);
  const ref = rasterize(item.reference, spec, patternClassIndex);
  const pred = rasterize(item.prediction, spec, patternClassIndex);
  const n = FIELD_NONE + 1;
  const confusion = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const refMask = new Uint8Array(spec.width * spec.height);
  const predMask = new Uint8Array(spec.width * spec.height);
  for (let i = 0; i < ref.values.length; i += 1) {
    const r = ref.filled[i] ? ref.values[i] : FIELD_NONE;
    const p = pred.filled[i] ? pred.values[i] : FIELD_NONE;
    confusion[r][p] += 1;
    if (r !== FIELD_NONE) refMask[i] = 1;
    if (p !== FIELD_NONE) predMask[i] = 1;
  }
  const classMetrics = fieldClassMetrics(confusion, spec.pxAreaHa);
  return {
    name: item.name,
    width: spec.width,
    height: spec.height,
    confusion,
    mask: fieldMaskMetrics(confusion),
    boundaryMcc: boundaryMcc(refMask, predMask, spec.width, spec.height, tolerancePx),
    tolerancePx,
    classMetrics,
    macroF1: fieldMacroF1(classMetrics),
    meta: item.meta,
  };
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

function classTable(metrics: FieldClassMetrics[], unit: "ha" | "px" = "ha"): string {
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
  const head = `| ref \\ pred | ${FIELD_CLASS_NAMES.join(" | ")} |`;
  const sep = `|---|${FIELD_CLASS_NAMES.map(() => "---").join("|")}|`;
  const rows = confusion.map(
    (row, i) => `| **${FIELD_CLASS_NAMES[i]}** | ${row.map((v) => String(v)).join(" | ")} |`,
  );
  return [head, sep, ...rows].join("\n");
}

function sumConfusion(reports: FieldsCaseReport[]): number[][] {
  const n = FIELD_NONE + 1;
  const total = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const report of reports) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) total[i][j] += report.confusion[i][j];
    }
  }
  return total;
}

export interface FieldsReportOptions {
  generatedAt?: string;
  targetPx: number;
  tolerancePx: number;
  note?: string;
}

export function renderFieldsMarkdownReport(
  reports: FieldsCaseReport[],
  options: FieldsReportOptions,
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const aggregate = sumConfusion(reports);
  const aggregateMask = fieldMaskMetrics(aggregate);
  const aggregateClasses = fieldClassMetrics(aggregate, 1);
  const mccs = reports
    .map((r) => r.boundaryMcc)
    .filter((v): v is number => v !== null);
  const meanMcc = mccs.length === 0 ? null : mccs.reduce((a, b) => a + b, 0) / mccs.length;
  const lines: string[] = [];
  lines.push("# Fields validation report — boundaries + cropping pattern");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Cases: ${reports.length}`);
  lines.push(`- Raster grid long side: ${options.targetPx} px`);
  lines.push(`- Boundary tolerance: ${options.tolerancePx} px`);
  if (options.note) lines.push(`- Note: ${options.note}`);
  lines.push("");
  lines.push(
    "> Field mask metrics treat every pixel outside a reference field as `no_field`",
  );
  lines.push(
    "> (true negative — field segmentation has no unlabelled exclusion zone).",
  );
  lines.push(
    "> Boundary MCC compares the ±tolerance boundary bands of both layers; class",
  );
  lines.push(
    "> metrics cover the pattern classes with `no_field` as the background row/column.",
  );
  lines.push("");
  lines.push("## Aggregate (all cases, summed confusion)");
  lines.push("");
  lines.push(`- Field mask — IoU: **${pct(aggregateMask.iou)}**, precision: **${pct(aggregateMask.precision)}**, recall: **${pct(aggregateMask.recall)}**, F1: **${pct(aggregateMask.f1)}**`);
  lines.push(`- Boundary MCC (mean over ${mccs.length}/${reports.length} cases): **${meanMcc === null ? "—" : meanMcc.toFixed(3)}**`);
  lines.push(`- Macro F1 over pattern classes (support > 0): **${pct(fieldMacroF1(aggregateClasses))}**`);
  lines.push("");
  lines.push(classTable(aggregateClasses, "px"));
  lines.push("");
  lines.push(confusionTable(aggregate));
  lines.push("");

  for (const report of reports) {
    lines.push(`## Case: ${report.name}`);
    if (report.meta?.year !== undefined) lines.push(`- Year: ${report.meta.year}`);
    if (report.meta?.note) lines.push(`- Note: ${report.meta.note}`);
    lines.push(
      `- Grid: ${report.width}×${report.height} px, boundary tolerance ${report.tolerancePx} px`,
    );
    lines.push(
      `- Field mask — IoU: ${pct(report.mask.iou)}, precision: ${pct(report.mask.precision)}, recall: ${pct(report.mask.recall)}, F1: ${pct(report.mask.f1)} (tp=${report.mask.tp} fp=${report.mask.fp} fn=${report.mask.fn} tn=${report.mask.tn})`,
    );
    lines.push(
      `- Boundary MCC: ${report.boundaryMcc === null ? "—" : report.boundaryMcc.toFixed(3)}, Macro F1: ${pct(report.macroF1)}`,
    );
    lines.push("");
    lines.push(classTable(report.classMetrics));
    lines.push("");
    lines.push(confusionTable(report.confusion));
    lines.push("");
  }
  return lines.join("\n");
}
