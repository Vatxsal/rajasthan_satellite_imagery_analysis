import type {
  ClassStat,
  ConfidenceTier,
  SummaryData,
  SummaryLanguage,
  TehsilZonalStat,
} from "../../analysis/types";
import { getCopy } from "./copy";

/** Hard cap from the email spec: rendered HTML above this never sends. */
export const MAX_HTML_BYTES = 100_000;
/** Attachment budget: the change-map JPEG is capped at ~80 KB (route enforces). */
export const MAX_CSV_BYTES = 1_000_000;

export interface ReportClassRow {
  code: number;
  label: string;
  hex: string;
  areaHa: number;
  /** Share of the total changed area (0–100), 0 when nothing changed. */
  pctOfChange: number;
}

export interface ReportEventRow {
  id: string;
  rank: number;
  classCode: number;
  classLabel: string;
  hex: string;
  confidence: ConfidenceTier | null;
  areaHa: number;
  place: string;
  lat: number;
  lon: number;
}

export interface ReportTehsilRow {
  name: string;
  changedHa: number;
  pctOfChange: number;
}

export interface ReportImage {
  /** `cid:` reference (real send) or a `data:`/`https:` URL (previews). */
  src: string;
  width: number;
  height: number;
  alt: string;
}

/** Everything the template renders — composed by the route from the analysis. */
export interface ReportEmailData {
  language: SummaryLanguage;
  areaName: string;
  areaLevel: "district" | "tehsil" | "ilr";
  dateA: string;
  dateB: string;
  gapDays: number;
  sensitivity: "low" | "medium" | "high";
  minPatchHa: number;
  inputMode: "single" | "composite";
  changedHa: number;
  /** changedHa / validHa × 100 (0 when nothing valid). */
  changedPct: number;
  patchCount: number;
  validPct: number;
  classes: ReportClassRow[];
  events: ReportEventRow[];
  tehsils: ReportTehsilRow[];
  includeSummary: boolean;
  summary: SummaryData | null;
  /** True when a summary was requested but could not be produced. */
  summaryUnavailable: boolean;
  image: ReportImage | null;
  deepLink: string;
  siteUrl: string;
  generatedAt: string;
}

/** Stats slice the composer needs (route passes these straight from the result). */
export interface ReportStatsSource {
  classes: ClassStat[];
  validPct: number;
  validHa: number;
  changedHa: number;
  tehsils: TehsilZonalStat[] | null;
  eventsTotal?: number;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const part = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function formatHa(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toLocaleString("en-IN", { maximumFractionDigits: 1 })} ha`;
}

export function formatNumber(value: number, fractionDigits = 1): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString("en-IN", { maximumFractionDigits: fractionDigits });
}

export function formatPct(value: number): string {
  return `${formatNumber(value, 1)}%`;
}

/** "2026-10-10" → "10 Oct 2026" (Latin month abbrev for both languages). */
export function formatEmailDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  return `${Number(match[3])} ${month} ${match[1]}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subject lines must be single-line and short (RFC: no raw CR/LF). */
export function sanitizeSubject(raw: string): string {
  const singleLine = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length > 90 ? `${singleLine.slice(0, 89)}…` : singleLine;
}

export function buildSubject(areaName: string, dateA: string, dateB: string): string {
  return sanitizeSubject(
    `Change report · ${areaName} · ${formatEmailDate(dateA)} to ${formatEmailDate(dateB)} (auto-generated)`,
  );
}

export function buildPreheader(data: ReportEmailData): string {
  const copy = getCopy(data.language);
  const raw = copy.preheader(
    data.areaName,
    formatEmailDate(data.dateA),
    formatEmailDate(data.dateB),
  );
  return raw.length > 96 ? `${raw.slice(0, 95)}…` : raw;
}

export function classRows(stats: ReportStatsSource): ReportClassRow[] {
  const changeClasses = stats.classes.filter((row) => row.areaHa > 0);
  const total = stats.changedHa > 0 ? stats.changedHa : 0;
  return changeClasses
    .map((row) => ({
      code: row.code,
      label: row.label,
      hex: rgbToHex(row.color),
      areaHa: row.areaHa,
      pctOfChange: total > 0 ? (row.areaHa / total) * 100 : 0,
    }))
    .sort((a, b) => b.areaHa - a.areaHa);
}

interface EventFeatureProperties {
  id?: string;
  classCode?: number;
  classLabel?: string;
  areaHa?: number;
  centroid?: [number, number];
  confidence?: ConfidenceTier;
  tehsilName?: string | null;
}

/** Top-N rows (features arrive largest-first, so the email's top-10 is stable). */
export function topEvents(
  features: GeoJSON.Feature[],
  limit = 10,
): ReportEventRow[] {
  return features.slice(0, limit).flatMap((feature, index) => {
    const props = (feature.properties ?? {}) as EventFeatureProperties;
    const id = String(props.id ?? feature.id ?? "");
    const centroid = props.centroid;
    if (!id || !Array.isArray(centroid) || centroid.length < 2) return [];
    return [
      {
        id,
        rank: index + 1,
        classCode: Number(props.classCode ?? -1),
        classLabel: String(props.classLabel ?? ""),
        hex: rgbToHex([128, 128, 128]),
        confidence: props.confidence ?? null,
        areaHa: Number(props.areaHa ?? 0),
        place: String(props.tehsilName ?? ""),
        lat: Number(centroid[1]),
        lon: Number(centroid[0]),
      },
    ];
  });
}

/** Colour comes from the class code via the shared palette (not feature props). */
export function withClassColors(
  rows: ReportEventRow[],
  classes: ReportClassRow[],
): ReportEventRow[] {
  const byCode = new Map(classes.map((row) => [row.code, row.hex]));
  return rows.map((row) => ({
    ...row,
    hex: byCode.get(row.classCode) ?? row.hex,
  }));
}

export function topTehsils(
  stats: ReportStatsSource,
  limit = 5,
): ReportTehsilRow[] {
  if (!stats.tehsils || stats.tehsils.length === 0) return [];
  const total = stats.changedHa > 0 ? stats.changedHa : 0;
  return [...stats.tehsils]
    .sort((a, b) => b.changedHa - a.changedHa)
    .slice(0, limit)
    .map((row) => ({
      name: row.name,
      changedHa: row.changedHa,
      pctOfChange: total > 0 ? (row.changedHa / total) * 100 : 0,
    }));
}

export interface ReportSourceInput {
  language: SummaryLanguage;
  areaName: string;
  areaLevel: "district" | "tehsil" | "ilr";
  dateA: string;
  dateB: string;
  gapDays: number;
  sensitivity: "low" | "medium" | "high";
  minPatchHa: number;
  inputMode: "single" | "composite";
  stats: ReportStatsSource;
  events: GeoJSON.Feature[];
  summary: SummaryData | null;
  includeSummary: boolean;
  summaryUnavailable: boolean;
  image: ReportImage | null;
  deepLink: string;
  siteUrl: string;
  generatedAt: string;
}

export function buildReportEmailData(input: ReportSourceInput): ReportEmailData {
  const { stats } = input;
  const classes = classRows(stats);
  const events = withClassColors(topEvents(input.events), classes);
  const changedPct =
    stats.validHa > 0 ? (stats.changedHa / stats.validHa) * 100 : 0;
  return {
    language: input.language,
    areaName: input.areaName,
    areaLevel: input.areaLevel,
    dateA: input.dateA,
    dateB: input.dateB,
    gapDays: input.gapDays,
    sensitivity: input.sensitivity,
    minPatchHa: input.minPatchHa,
    inputMode: input.inputMode,
    changedHa: stats.changedHa,
    changedPct,
    patchCount: stats.eventsTotal ?? input.events.length,
    validPct: stats.validPct,
    classes,
    events,
    tehsils: topTehsils(stats),
    includeSummary: input.includeSummary,
    summary: input.includeSummary ? input.summary : null,
    summaryUnavailable: input.includeSummary && input.summaryUnavailable,
    image: input.image,
    deepLink: input.deepLink,
    siteUrl: input.siteUrl,
    generatedAt: input.generatedAt,
  };
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * ALL detected events as RFC-4180 CSV (largest-first), capped at 1 MB.
 * Columns: id,class,area_ha,confidence,tehsil,lat,lon,link
 */
export function buildEventsCsv(
  features: GeoJSON.Feature[],
  deepLink: string,
): string {
  const header = "id,class,area_ha,confidence,tehsil,lat,lon,link";
  const rows: string[] = [header];
  let size = header.length + 2;
  for (const feature of features) {
    const props = (feature.properties ?? {}) as EventFeatureProperties;
    const id = String(props.id ?? feature.id ?? "");
    const centroid = props.centroid;
    if (!id || !Array.isArray(centroid) || centroid.length < 2) continue;
    const row = [
      csvCell(id),
      csvCell(String(props.classLabel ?? "")),
      csvCell(String(props.areaHa ?? 0)),
      csvCell(String(props.confidence ?? "")),
      csvCell(String(props.tehsilName ?? "")),
      Number(centroid[1]).toFixed(5),
      Number(centroid[0]).toFixed(5),
      csvCell(`${deepLink}&e=${id}`),
    ].join(",");
    if (size + row.length + 2 > MAX_CSV_BYTES) break;
    rows.push(row);
    size += row.length + 2;
  }
  return `${rows.join("\r\n")}\r\n`;
}

export function assertHtmlBudget(html: string): void {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new Error(
      `EMAIL_HTML_TOO_LARGE: ${Buffer.byteLength(html, "utf8")} bytes > ${MAX_HTML_BYTES}`,
    );
  }
}
