/**
 * Pattern run orchestration (Phase 2): fetch the 12 monthly NDVI rasters in
 * bounded batches, validate them against the analysis grid, reduce them to
 * per-field NDVI curves, classify every field and (optionally) group the
 * curves — emitting NDJSON progress frames as it goes.
 *
 * Dependencies are injected (fields + fetchMonth + onEvent) so the node test
 * harness can drive the whole pipeline with synthetic rasters and never touch
 * the network or decode a GeoTIFF (see scripts/fields-pattern.test.ts).
 */
import type { BBox } from "@/lib/data";
import type { AnalysisGrid } from "@/lib/analysis/types";
import type { FieldsFiltered } from "./query";
import {
  agriYearMonths,
  classifiable,
  classifySeries,
  gapFill,
  groupSeries,
  patternError,
  rasterizeFieldZones,
  seriesMetrics,
  smooth3,
  zonalMonthlyMeans,
  type PatternMetrics,
  type PatternMonth,
  type ZonalRaster,
} from "./pattern";
import {
  PATTERN_CLASSES,
  PATTERN_FETCH_BATCH,
  type PatternClass,
} from "./config";

/** One month's render after parsing (NDVI median + valid mask). */
export type PatternMonthRaster = ZonalRaster;

export interface PatternFieldResult {
  id: string;
  cls: PatternClass;
  /** k-means group id, null when grouping is off / unavailable / unclassified. */
  group: number | null;
  /** Gap-filled 12-month curve (3 dp), null when too few months observed. */
  series: number[] | null;
  validMonths: number;
  metrics: PatternMetrics | null;
}

export interface PatternGroupingInfo {
  enabled: boolean;
  /** Cluster count, null when grouping was requested but produced nothing. */
  k: number | null;
  /** Fields per group (ascending group id); empty when k is null. */
  sizes: number[];
}

export interface PatternResult {
  bbox: BBox;
  year: number;
  minConfidence: number;
  /** `YYYY-MM` labels of the 12 curve points (Jun of year … May of year+1). */
  months: string[];
  count: number;
  truncated: boolean;
  grouping: PatternGroupingInfo;
  /** Every PATTERN_CLASSES key, 0-filled. */
  classes: Record<PatternClass, number>;
  estimatedPu: number;
  fields: PatternFieldResult[];
}

export interface PatternParams {
  bbox: BBox;
  year: number;
  minConfidence: number;
  grouping: boolean;
  grid: AnalysisGrid;
  estimatedPu: number;
}

export interface PatternDeps {
  fields: FieldsFiltered;
  fetchMonth: (month: PatternMonth) => Promise<PatternMonthRaster>;
  /** NDJSON progress frames (stage/month) — the route forwards them. */
  onEvent?: (frame: unknown) => void;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundMetrics(metrics: PatternMetrics): PatternMetrics {
  return {
    mean: round3(metrics.mean),
    min: round3(metrics.min),
    max: round3(metrics.max),
    peakMonth: metrics.peakMonth,
    greenMonths: metrics.greenMonths,
    kharifMean: round3(metrics.kharifMean),
    rabiMean: round3(metrics.rabiMean),
    zaidMean: round3(metrics.zaidMean),
  };
}

function fieldId(feature: GeoJSON.Feature, index: number): string {
  const id = feature.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  return `field-${index}`;
}

function emptyClasses(): Record<PatternClass, number> {
  const classes = {} as Record<PatternClass, number>;
  for (const name of PATTERN_CLASSES) classes[name] = 0;
  return classes;
}

/**
 * Runs one pattern analysis. Progress frames, in order:
 *
 *   {"type":"stage","stage":"ndvi"}
 *   {"type":"month","index":0..11,"label":"YYYY-MM"}   (per fetched month)
 *   {"type":"stage","stage":"analyze"}
 *
 * The route adds the leading `fields` stage and the trailing `result` frame.
 * Failures throw (duck-typed { status, code } contract errors where the
 * route can map them); the route converts them to an `error` frame once the
 * stream is open.
 */
export async function runPattern(params: PatternParams, deps: PatternDeps): Promise<PatternResult> {
  const { grid, grouping } = params;
  const months = agriYearMonths(params.year);
  deps.onEvent?.({ type: "stage", stage: "ndvi" });

  // 12 monthly renders, fetched in small batches: one slow/cloudy month
  // must not serialise the whole run, but unbounded concurrency would trip
  // the token/rate limiter.
  const rasters: PatternMonthRaster[] = new Array(months.length);
  for (let start = 0; start < months.length; start += PATTERN_FETCH_BATCH) {
    const batch = months.slice(start, start + PATTERN_FETCH_BATCH);
    const settled = await Promise.allSettled(batch.map((month) => deps.fetchMonth(month)));
    let failure: unknown = null;
    for (let offset = 0; offset < settled.length; offset++) {
      const outcome = settled[offset];
      const month = batch[offset];
      if (outcome.status === "rejected") {
        if (failure === null) failure = outcome.reason;
        continue;
      }
      const raster = outcome.value;
      if (raster.width !== grid.width || raster.height !== grid.height) {
        if (failure === null) {
          failure = patternError(
            502,
            "UPSTREAM_ERROR",
            `Monthly NDVI raster for ${month.label} is ${raster.width}×${raster.height}; expected ${grid.width}×${grid.height}.`,
          );
        }
        continue;
      }
      rasters[start + offset] = raster;
      deps.onEvent?.({ type: "month", index: month.index, label: month.label });
    }
    if (failure !== null) throw failure;
  }

  deps.onEvent?.({ type: "stage", stage: "analyze" });

  const features = deps.fields.fields.features;
  const zoneCount = features.length;
  const zones = rasterizeFieldZones(features, grid);

  // Per-field monthly means: series[field][month] (null = no valid pixels).
  const observed: Array<Array<number | null>> = Array.from({ length: zoneCount }, () =>
    new Array<number | null>(months.length).fill(null),
  );
  for (let monthIndex = 0; monthIndex < months.length; monthIndex++) {
    const means = zonalMonthlyMeans(zones, rasters[monthIndex], zoneCount);
    for (let field = 0; field < zoneCount; field++) {
      observed[field][monthIndex] = means[field];
    }
  }

  const classes = emptyClasses();
  const results: PatternFieldResult[] = [];
  const groupable: Array<{ fieldIndex: number; series: number[] }> = [];

  for (let field = 0; field < zoneCount; field++) {
    const series = observed[field];
    let validMonths = 0;
    for (const value of series) if (value !== null) validMonths++;

    const filled = classifiable(validMonths) ? gapFill(series) : null;
    if (filled === null) {
      classes.unclassified += 1;
      results.push({
        id: fieldId(features[field], field),
        cls: "unclassified",
        group: null,
        series: null,
        validMonths,
        metrics: null,
      });
      continue;
    }

    const metrics = seriesMetrics(filled);
    const cls = classifySeries(smooth3(filled), metrics);
    classes[cls] += 1;
    results.push({
      id: fieldId(features[field], field),
      cls,
      group: null,
      series: filled.map(round3),
      validMonths,
      metrics: roundMetrics(metrics),
    });
    groupable.push({ fieldIndex: field, series: filled });
  }

  const groupingInfo: PatternGroupingInfo = { enabled: grouping, k: null, sizes: [] };
  if (grouping && groupable.length > 0) {
    const grouped = groupSeries(groupable.map((entry) => entry.series));
    if (grouped) {
      const sizes = new Array<number>(grouped.k).fill(0);
      grouped.labels.forEach((label, index) => {
        sizes[label] += 1;
        results[groupable[index].fieldIndex].group = label;
      });
      groupingInfo.k = grouped.k;
      groupingInfo.sizes = sizes;
    }
  }

  return {
    bbox: params.bbox,
    year: params.year,
    minConfidence: params.minConfidence,
    months: months.map((month) => month.label),
    count: deps.fields.count,
    truncated: deps.fields.truncated,
    grouping: groupingInfo,
    classes,
    estimatedPu: params.estimatedPu,
    fields: results,
  };
}
