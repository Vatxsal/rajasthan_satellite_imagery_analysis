/**
 * Fields & cropping-pattern panel summaries (Phase 2): agri-year progress,
 * per-class stats (count / area / share) for the legend-filter chips, mean
 * NDVI small multiples per pattern class or k-means group, and the honest
 * text labels (analysis scope, PU estimate, provisional-year note).
 *
 * Pure — no store, no DOM, no network — so scripts/fields-style.test.ts can
 * lock every number and string down. Structural row types keep this module
 * import-light (no client or run orchestration graph).
 */
import { PATTERN_CLASSES, type PatternClass } from "./config";

/** Minimum row shape the summaries need (PatternClientResult / run result rows). */
export interface PatternRowLike {
  id: string;
  cls: PatternClass;
  group: number | null;
  series: number[] | null;
}

// ── Agri-year progress ──────────────────────────────────────────────────────

/**
 * True while the agri year (June of `year` … May of `year + 1`) is still
 * running: the rabi half has not finished, so seasonal labels that read the
 * missing months as fact must not be trusted (classifySeries inProgress
 * override, panel provisional note).
 */
export function agriYearInProgress(year: number, now: Date = new Date()): boolean {
  return now.getTime() < Date.UTC(year + 1, 5, 1); // 1 Jun of year + 1
}

/** Provisional-year banner text, or null for a completed agri year. */
export function provisionalNote(year: number, now: Date = new Date()): string | null {
  return agriYearInProgress(year, now) ? "Provisional: rabi/zaid not complete yet" : null;
}

// ── Legend stats ────────────────────────────────────────────────────────────

export interface ClassStat {
  cls: PatternClass;
  count: number;
  /** Sum of joined field areas (m²); 0 when no areas could be joined. */
  areaM2: number;
  /** Area share of all classified area (falls back to count share when no
   *  areas exist), 0..1. */
  share: number;
}

/**
 * Per-class count/area/share for the legend chips, in declaration order and
 * only classes that actually occur. Areas join by field id; rows without a
 * known area still count. `unclassified` is included — the panel renders it
 * as its own separated row with a tooltip.
 */
export function patternClassStats(
  rows: ReadonlyArray<{ id: string; cls: PatternClass }>,
  areaById: ReadonlyMap<string, number>,
): ClassStat[] {
  const counts = new Map<PatternClass, { count: number; areaM2: number }>();
  let totalArea = 0;
  for (const row of rows) {
    const entry = counts.get(row.cls) ?? { count: 0, areaM2: 0 };
    entry.count += 1;
    const area = areaById.get(row.id);
    if (typeof area === "number" && Number.isFinite(area) && area >= 0) {
      entry.areaM2 += area;
      totalArea += area;
    }
    counts.set(row.cls, entry);
  }

  return PATTERN_CLASSES.filter((cls) => (counts.get(cls)?.count ?? 0) > 0).map((cls) => {
    const entry = counts.get(cls) as { count: number; areaM2: number };
    const share =
      totalArea > 0
        ? entry.areaM2 / totalArea
        : entry.count / Math.max(1, rows.length);
    return { cls, count: entry.count, areaM2: entry.areaM2, share };
  });
}

// ── Small multiples ─────────────────────────────────────────────────────────

export interface MeanSeriesRow {
  /** Class id or `g{group}` key (match legend swatches). */
  key: string;
  cls: PatternClass | null;
  group: number | null;
  /** Fields contributing at least one month to the mean. */
  n: number;
  /** Month-wise mean NDVI (3 dp), length = shared series length. */
  mean: number[];
}

function meanSeries(
  rows: ReadonlyArray<PatternRowLike>,
  keyOf: (row: PatternRowLike) => { key: string; cls: PatternClass | null; group: number | null } | null,
): MeanSeriesRow[] {
  const buckets = new Map<
    string,
    { cls: PatternClass | null; group: number | null; n: number; sums: number[]; counts: number[] }
  >();
  for (const row of rows) {
    if (!row.series || row.series.length === 0) continue;
    const identity = keyOf(row);
    if (!identity) continue;
    const bucket = buckets.get(identity.key) ?? {
      cls: identity.cls,
      group: identity.group,
      n: 0,
      sums: new Array<number>(row.series.length).fill(0),
      counts: new Array<number>(row.series.length).fill(0),
    };
    bucket.n += 1;
    row.series.forEach((value, index) => {
      if (index >= bucket.sums.length) return;
      bucket.sums[index] += value;
      bucket.counts[index] += 1;
    });
    buckets.set(identity.key, bucket);
  }

  const out: MeanSeriesRow[] = [];
  for (const [key, bucket] of buckets) {
    const mean = bucket.sums.map((sum, index) =>
      bucket.counts[index] > 0 ? Math.round((sum / bucket.counts[index]) * 1000) / 1000 : 0,
    );
    out.push({ key, cls: bucket.cls, group: bucket.group, n: bucket.n, mean });
  }
  return out;
}

/** Mean 12-month curve per pattern class (declaration order, classes present). */
export function meanSeriesByClass(rows: ReadonlyArray<PatternRowLike>): MeanSeriesRow[] {
  const grouped = meanSeries(rows, (row) => ({ key: row.cls, cls: row.cls, group: null }));
  const order = new Map(PATTERN_CLASSES.map((cls, index) => [cls, index]));
  return grouped.sort(
    (a, b) => (order.get(a.cls as PatternClass) ?? 99) - (order.get(b.cls as PatternClass) ?? 99),
  );
}

/** Mean 12-month curve per k-means group (group id ascending; grouped rows only). */
export function meanSeriesByGroup(rows: ReadonlyArray<PatternRowLike>): MeanSeriesRow[] {
  const grouped = meanSeries(rows, (row) =>
    row.group === null ? null : { key: `g${row.group}`, cls: null, group: row.group },
  );
  return grouped.sort((a, b) => (a.group ?? 0) - (b.group ?? 0));
}

// ── Labels ──────────────────────────────────────────────────────────────────

export type FieldScope = "viewport" | "tehsil";

/**
 * Scope caption under the loaded-fields card, e.g.
 * `Analysis area: current view (2.43 km²)` /
 * `Analysis area: selected tehsil — Bassi (17.4 km²)`.
 */
export function scopeText(
  scope: FieldScope,
  areaKm2: number | null,
  tehsilName?: string | null,
): string {
  const area = areaKm2 !== null && Number.isFinite(areaKm2) ? `${areaKm2.toFixed(2)} km²` : "—";
  if (scope === "tehsil") {
    const name = tehsilName ? ` — ${tehsilName}` : "";
    return `Analysis area: selected tehsil${name} (${area})`;
  }
  return `Analysis area: current view (${area})`;
}

/** PU estimate rounded to one decimal: `about 17.7 PU`. */
export function puLabel(estimatedPu: number): string {
  const value = Number.isFinite(estimatedPu) ? estimatedPu : 0;
  return `about ${value.toFixed(1)} PU`;
}

/** Legend share as a whole percent: 0.234 → `23%`. */
export function shareLabel(share: number): string {
  const value = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  return `${Math.round(value * 100)}%`;
}

/** Area label for one chip: hectares with adaptive precision. */
export function areaHaLabel(areaM2: number): string {
  const ha = areaM2 / 10_000;
  if (!Number.isFinite(ha) || ha <= 0) return "—";
  if (ha >= 100 || Number.isInteger(ha)) return `${ha.toFixed(0)} ha`;
  return `${ha.toFixed(1)} ha`;
}
