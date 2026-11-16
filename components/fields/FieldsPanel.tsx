"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Layers,
  Loader2,
  Play,
  Sprout,
  Target,
} from "lucide-react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Segmented from "@/components/ui/Segmented";
import Slider from "@/components/ui/Slider";
import FeatureLock, { useLocked } from "@/components/ui/FeatureLock";
import { cn } from "@/components/ui/cn";
import { bboxAreaKm2 } from "@/lib/cdse/geometry";
import {
  FIELDS_ATTRIBUTION_CONFIDENCE,
  FIELDS_ATTRIBUTION_VECTORS,
} from "@/lib/fields/config";
import {
  PATTERN_CLASS_LABELS,
  patternClassColor,
} from "@/lib/fields/colors";
import { groupColor } from "@/lib/fields/style";
import {
  areaHaLabel,
  meanSeriesByClass,
  meanSeriesByGroup,
  patternClassStats,
  provisionalNote,
  puLabel,
  scopeText,
  shareLabel,
  type ClassStat,
} from "@/lib/fields/summary";
import { focusFieldsFeature, setFieldsFeatureHover } from "@/lib/fields/mapBridge";
import { getMainMap } from "@/lib/compare/bridge";
import { formatArea, type AreaUnit } from "@/lib/format";
import type { BBox } from "@/lib/data";
import type { PatternClass } from "@/lib/fields/config";
import { useFieldsStore } from "@/store/useFieldsStore";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useAppStore } from "@/store/useAppStore";

/** Viewport bbox from the main map (null before the map is ready). */
function viewportBBox(): BBox | null {
  const map = getMainMap();
  if (!map) return null;
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

function formatHa(m2: number, unit: AreaUnit): string {
  const ha = m2 / 10_000;
  const opts = unit === "ha" ? { maximumFractionDigits: ha >= 100 ? 0 : 1 } : {};
  return formatArea(ha, unit, opts);
}

/** `2024` → `2024–25` (agri-year caption). */
function yearLabel(year: number): string {
  return `${year}–${String(year + 1).slice(2)}`;
}

/** Tiny 12-point NDVI sparkline (no chart library). */
function SeriesSparkline({
  series,
  ariaLabel = "12-month NDVI curve",
}: {
  series: number[];
  ariaLabel?: string;
}) {
  const width = 240;
  const height = 56;
  const pad = 4;
  const min = Math.min(...series, 0);
  const max = Math.max(...series, 0.1);
  const span = Math.max(0.05, max - min);
  const points = series
    .map((value, index) => {
      const x = pad + (index / Math.max(1, series.length - 1)) * (width - pad * 2);
      const y = height - pad - ((value - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full rounded border border-border bg-surface-2"
      role="img"
      aria-label={ariaLabel}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Tooltip for the safety-fallback class (never a crop species). */
const UNCLASSIFIED_TIP =
  "Too few observed months or no clear seasonal shape — the rules could not " +
  "place this curve. It is never a crop species, and unfinished agri years " +
  "land here too.";

/**
 * One legend row: a toggle chip (count · area · share) plus a compact "Only"
 * action. Pressed = the class is in the visible set; a dimmed chip is
 * ghosted on the map (muted opacity), not hidden.
 */
function LegendChip({
  stat,
  pressed,
  onToggle,
  onOnly,
  tooltip,
}: {
  stat: ClassStat;
  pressed: boolean;
  onToggle: () => void;
  onOnly: () => void;
  tooltip?: string;
}) {
  const label = PATTERN_CLASS_LABELS[stat.cls];
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full items-stretch overflow-hidden rounded-sm border",
        pressed ? "border-accent bg-accent-soft" : "border-border bg-surface-2 opacity-60",
      )}
    >
      <button
        type="button"
        aria-pressed={pressed}
        title={tooltip ?? label}
        onClick={onToggle}
        className="flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-left"
      >
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ background: patternClassColor(stat.cls) }}
        />
        <span className="truncate text-xs font-medium text-text">{label}</span>
        <span className="mono-nums text-[10px] text-muted">{stat.count}</span>
        <span className="mono-nums text-[10px] text-muted">{areaHaLabel(stat.areaM2)}</span>
        <span className="mono-nums text-[10px] text-muted">{shareLabel(stat.share)}</span>
      </button>
      <button
        type="button"
        title={`Show only ${label.toLowerCase()} parcels`}
        onClick={onOnly}
        className="shrink-0 border-l border-border px-1.5 text-[10px] text-muted transition-colors duration-150 hover:text-text"
      >
        Only
      </button>
    </div>
  );
}

/**
 * Fields & cropping pattern sidebar (Phase 3): load parcel boundaries for the
 * current map viewport (or the selected tehsil), then run the 12-month NDVI
 * pattern classification and inspect per-field curves. Everything stops at
 * ≤25 km² (PU budget).
 */
export default function FieldsPanel() {
  const areaUnit = usePreferencesStore((s) => s.values.units.areaUnit);
  const year = useFieldsStore((s) => s.year);
  const minConfidence = useFieldsStore((s) => s.minConfidence);
  const grouping = useFieldsStore((s) => s.grouping);
  const setYear = useFieldsStore((s) => s.setYear);
  const setMinConfidence = useFieldsStore((s) => s.setMinConfidence);
  const setGrouping = useFieldsStore((s) => s.setGrouping);
  const visible = useFieldsStore((s) => s.visible);
  const toggleVisible = useFieldsStore((s) => s.toggleVisible);

  const colorBy = useFieldsStore((s) => s.colorBy);
  const setColorBy = useFieldsStore((s) => s.setColorBy);
  const renderMode = useFieldsStore((s) => s.renderMode);
  const setRenderMode = useFieldsStore((s) => s.setRenderMode);
  const scope = useFieldsStore((s) => s.scope);
  const setScope = useFieldsStore((s) => s.setScope);
  const loadedScope = useFieldsStore((s) => s.loadedScope);
  const filterClasses = useFieldsStore((s) => s.filterClasses);
  const toggleClassFilter = useFieldsStore((s) => s.toggleClassFilter);
  const onlyClassFilter = useFieldsStore((s) => s.onlyClassFilter);
  const clearClassFilter = useFieldsStore((s) => s.clearClassFilter);

  const loading = useFieldsStore((s) => s.loading);
  const error = useFieldsStore((s) => s.error);
  const count = useFieldsStore((s) => s.count);
  const truncated = useFieldsStore((s) => s.truncated);
  const totalAreaM2 = useFieldsStore((s) => s.totalAreaM2);
  const confidenceAvailable = useFieldsStore((s) => s.confidenceAvailable);
  const selectedAreaKm2 = useFieldsStore((s) => s.selectedAreaKm2);
  const fields = useFieldsStore((s) => s.fields);
  const loadFields = useFieldsStore((s) => s.loadFields);

  const patternRunning = useFieldsStore((s) => s.patternRunning);
  const patternStage = useFieldsStore((s) => s.patternStage);
  const patternMonthsDone = useFieldsStore((s) => s.patternMonthsDone);
  const patternError = useFieldsStore((s) => s.patternError);
  const pattern = useFieldsStore((s) => s.pattern);
  const runPattern = useFieldsStore((s) => s.runPattern);
  const selectedFieldId = useFieldsStore((s) => s.selectedFieldId);
  const selectField = useFieldsStore((s) => s.selectField);
  const lockedPattern = useLocked("fields.pattern");

  const tehsilSel = useAppStore((s) => s.tehsilSel);
  const [pendingArea, setPendingArea] = useState<number | null>(null);

  const selectedField = useMemo(() => {
    if (!pattern || !selectedFieldId) return null;
    return pattern.fields.find((row) => row.id === selectedFieldId) ?? null;
  }, [pattern, selectedFieldId]);

  const areaById = useMemo(() => {
    const map = new Map<string, number>();
    for (const feature of fields?.features ?? []) map.set(String(feature.id), feature.properties.areaM2);
    return map;
  }, [fields]);

  const classStats = useMemo(
    () => (pattern ? patternClassStats(pattern.fields, areaById) : []),
    [pattern, areaById],
  );
  const classifiedStats = classStats.filter((stat) => stat.cls !== "unclassified");
  const unclassifiedStat = classStats.find((stat) => stat.cls === "unclassified") ?? null;

  const isClassPressed = (cls: PatternClass): boolean =>
    filterClasses.length === 0 || filterClasses.includes(cls);

  const listedRows = useMemo(() => {
    if (!pattern) return [];
    const rows =
      filterClasses.length > 0
        ? pattern.fields.filter((row) => filterClasses.includes(row.cls))
        : pattern.fields;
    return rows;
  }, [pattern, filterClasses]);

  const classMeans = useMemo(() => (pattern ? meanSeriesByClass(pattern.fields) : []), [pattern]);
  const groupMeans = useMemo(() => (pattern ? meanSeriesByGroup(pattern.fields) : []), [pattern]);
  const groupCount = pattern?.grouping.k ?? 0;
  const provisional = provisionalNote(year);

  const stageLabel = (() => {
    switch (patternStage) {
      case "fields":
        return "Loading fields…";
      case "ndvi":
        return `Fetching monthly NDVI (${patternMonthsDone}/12)…`;
      case "analyze":
        return "Classifying curves…";
      default:
        return patternRunning ? "Working…" : null;
    }
  })();

  const onLoad = () => {
    const tehsilBbox = scope === "tehsil" ? (tehsilSel?.bbox ?? null) : null;
    const bbox = tehsilBbox ?? viewportBBox();
    if (!bbox) return;
    setPendingArea(bboxAreaKm2(bbox));
    void loadFields(bbox, {
      scope,
      name: scope === "tehsil" ? (tehsilSel?.name ?? null) : null,
    });
  };

  const onRowActivate = (row: { id: string }) => {
    if (row.id === selectedFieldId) {
      selectField(null);
      return;
    }
    selectField(row.id);
    const map = getMainMap();
    if (map) focusFieldsFeature(map, row.id);
  };

  const onRowHover = (row: { id: string }, on: boolean) => {
    setFieldsFeatureHover(getMainMap(), row.id, on);
  };

  const canRunPattern = Boolean(fields && count > 0 && !patternRunning && !loading && !lockedPattern);
  const areaTooLarge = pendingArea !== null && pendingArea > 25 && !fields;

  return (
    <div className="space-y-5 p-3">
      {/* ── controls ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="section-label">Selection</h3>
        <p className="text-xs text-muted">
          Zoom the map to a small area (≤&nbsp;25&nbsp;km²), then load field boundaries for the
          selected scope.
        </p>

        <div className="space-y-2">
          <label className="text-xs text-muted" htmlFor="fields-year">
            Agri year
          </label>
          <Segmented
            ariaLabel="Agri year"
            id="fields-year"
            value={String(year)}
            onChange={(value) => setYear(Number(value) as typeof year)}
            options={[
              { value: "2024", label: yearLabel(2024) },
              { value: "2025", label: yearLabel(2025) },
              { value: "2026", label: yearLabel(2026) },
            ]}
          />
          {provisional && (
            <p className="text-[11px] text-warning">
              {provisional} — {yearLabel(year)} has not finished, so fallow and kharif-only
              labels are withheld (shown as Unclassified).
              {year >= 2026 &&
                " The Fields of the World archive also publishes 2024–25 and 2025–26 boundaries only, so no parcels load for this year yet."}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <span className="text-xs text-muted">Analysis scope</span>
          <Segmented
            ariaLabel="Analysis scope"
            value={scope}
            onChange={(value) => setScope(value)}
            options={[
              { value: "viewport", label: "Current view" },
              { value: "tehsil", label: "Selected tehsil" },
            ]}
          />
          {scope === "tehsil" && !tehsilSel && (
            <p className="text-[11px] text-muted">
              No tehsil selected — click the map and use “Select this tehsil” in the inspector, or
              switch back to the current view.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <label className="text-xs text-muted" htmlFor="fields-confidence">
              Min confidence
            </label>
            <span className="mono-nums text-xs text-text">{minConfidence}</span>
          </div>
          <Slider
            id="fields-confidence"
            min={0}
            max={100}
            step={1}
            value={minConfidence}
            onChange={(event) => setMinConfidence(Number(event.target.value))}
          />
        </div>

        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={onLoad}
          disabled={loading || patternRunning || (scope === "tehsil" && !tehsilSel)}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Target size={14} />}
          {loading ? "Loading fields…" : "Load fields for scope"}
        </Button>

        {areaTooLarge && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            Scope is {pendingArea.toFixed(1)} km² — zoom in until it is under 25 km².
          </p>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-xs text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              <span className="mono-nums font-medium">{error.code}</span> — {error.message}
            </span>
          </p>
        )}
      </section>

      {/* ── loaded boundaries ────────────────────────────────────── */}
      {fields && (
        <section className="space-y-3 rounded border border-border bg-surface-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Layers size={14} className="text-accent" />
              <p className="text-sm font-medium text-text">
                {count.toLocaleString("en")} field{count === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={visible}
              aria-label="Show field boundaries"
              onClick={toggleVisible}
              className={cn(
                "inline-flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors duration-150",
                visible ? "border-accent bg-accent-soft" : "border-border bg-surface",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 rounded-full transition-transform duration-150",
                  visible ? "translate-x-5 bg-accent" : "translate-x-0 bg-muted",
                )}
              />
            </button>
          </div>

          <p className="text-[11px] text-muted">
            {loadedScope
              ? scopeText(loadedScope.scope, selectedAreaKm2, loadedScope.name)
              : scopeText("viewport", selectedAreaKm2)}
          </p>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Total area</dt>
            <dd className="mono-nums text-right text-text">{formatHa(totalAreaM2, areaUnit)}</dd>
            <dt className="text-muted">Confidence</dt>
            <dd className="text-right text-text">
              {confidenceAvailable ? `≥ ${minConfidence}` : "unavailable"}
            </dd>
          </dl>

          {count === 0 && (
            <p className="text-[11px] text-warning">
              {year >= 2026
                ? `No ${yearLabel(year)} field boundaries in the archive yet — Fields of the World ` +
                  "currently publishes 2024–25 and 2025–26 for Rajasthan. Pick an earlier agri year."
                : `No fields in this area at ≥ ${minConfidence} confidence — zoom to a farmed ` +
                  "area or lower the confidence threshold."}
            </p>
          )}

          {truncated && (
            <p className="text-[11px] text-warning">
              Result capped — zoom in for the full set of parcels.
            </p>
          )}

          {/* ── pattern run ─────────────────────────────────────── */}
          <div className="space-y-2 border-t border-border pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={grouping}
                  onChange={(event) => setGrouping(event.target.checked)}
                  disabled={patternRunning}
                  className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                />
                Group similar curves (k-means)
              </label>
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button
                variant="primary"
                size="sm"
                className="w-full"
                onClick={() => void runPattern()}
                disabled={!canRunPattern}
              >
                {patternRunning ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
                {pattern ? "Re-run cropping pattern" : "Run cropping pattern"}
              </Button>
              <FeatureLock capability="fields.pattern" label="Cropping pattern" />
            </div>
            {lockedPattern && (
              <p className="text-[11px] text-muted">
                Cropping-pattern analysis is part of the full-access SSO session.
              </p>
            )}

            {stageLabel && (
              <div className="space-y-1">
                <p className="text-xs text-muted">{stageLabel}</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{
                      width: `${Math.round((patternMonthsDone / 12) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {patternError && (
              <p className="flex items-start gap-1.5 text-xs text-danger">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  <span className="mono-nums font-medium">{patternError.code}</span> —{" "}
                  {patternError.message}
                </span>
              </p>
            )}
          </div>

          {/* ── map style: colour-by + render mode ──────────────── */}
          <div className="space-y-2 border-t border-border pt-2.5">
            <label className="text-xs text-muted">Colour parcels by</label>
            <Segmented
              ariaLabel="Colour parcels by"
              value={colorBy}
              onChange={(value) => setColorBy(value)}
              options={[
                { value: "pattern", label: "Pattern" },
                { value: "group", label: "Group" },
                { value: "confidence", label: "Confidence" },
              ]}
            />
            {colorBy === "group" && groupCount === 0 && (
              <p className="text-[11px] text-muted">
                No curve groups yet — run the pattern with grouping on to colour by group
                (showing pattern colours for now).
              </p>
            )}
            {colorBy === "confidence" && !confidenceAvailable && (
              <p className="text-[11px] text-muted">
                Confidence is unavailable for this selection — showing pattern colours for now.
              </p>
            )}

            <label className="text-xs text-muted">Parcel style</label>
            <Segmented
              ariaLabel="Parcel style"
              value={renderMode}
              onChange={(value) => setRenderMode(value)}
              options={[
                { value: "fill", label: "Fill + outline" },
                { value: "outline", label: "Outline only" },
              ]}
            />
          </div>
        </section>
      )}

      {/* ── pattern result ───────────────────────────────────────── */}
      {pattern && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Sprout size={14} className="text-accent" />
            <h3 className="section-label">Cropping pattern</h3>
          </div>

          {/* legend: multi-select class filters (count · area · share) */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {classifiedStats.map((stat) => (
                <LegendChip
                  key={stat.cls}
                  stat={stat}
                  pressed={isClassPressed(stat.cls)}
                  onToggle={() => toggleClassFilter(stat.cls)}
                  onOnly={() => onlyClassFilter(stat.cls)}
                />
              ))}
              {filterClasses.length > 0 && (
                <button
                  type="button"
                  onClick={clearClassFilter}
                  className="rounded-sm border border-border bg-surface px-1.5 py-1 text-xs text-accent transition-colors duration-150 hover:bg-surface-2"
                >
                  Show all
                </button>
              )}
            </div>
            {unclassifiedStat && (
              <div className="border-t border-border pt-1.5">
                <LegendChip
                  stat={unclassifiedStat}
                  pressed={isClassPressed(unclassifiedStat.cls)}
                  onToggle={() => toggleClassFilter(unclassifiedStat.cls)}
                  onOnly={() => onlyClassFilter(unclassifiedStat.cls)}
                  tooltip={UNCLASSIFIED_TIP}
                />
              </div>
            )}
            {classStats.length === 0 && (
              <p className="text-xs text-muted">No classified fields in this selection.</p>
            )}
            {filterClasses.length > 0 && (
              <p className="text-[11px] text-muted">
                Showing {listedRows.length} of {pattern.fields.length} fields — click “Show all” to
                clear the filter.
              </p>
            )}
          </div>

          <p className="mono-nums text-[11px] text-muted">
            {pattern.count} field{pattern.count === 1 ? "" : "s"} · est.{" "}
            {puLabel(pattern.estimatedPu)} ·{" "}
            {pattern.grouping.enabled
              ? pattern.grouping.k !== null
                ? `${pattern.grouping.k} groups`
                : "grouping unavailable"
              : "no grouping"}
            {pattern.truncated ? " · truncated" : ""}
          </p>

          {/* ── field list ─────────────────────────────────────── */}
          <div className="space-y-1.5">
            <h4 className="section-label">Fields</h4>
            <div className="max-h-48 space-y-1 overflow-y-auto pr-0.5">
              {listedRows.slice(0, 80).map((row) => {
                const active = row.id === selectedFieldId;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => onRowActivate(row)}
                    onMouseEnter={() => onRowHover(row, true)}
                    onMouseLeave={() => onRowHover(row, false)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors duration-150",
                      active
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:bg-surface-2",
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: patternClassColor(row.cls) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-text">
                      {row.id}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {PATTERN_CLASS_LABELS[row.cls]}
                      {row.group !== null ? ` · g${row.group}` : ""}
                    </span>
                  </button>
                );
              })}
              {listedRows.length === 0 && (
                <p className="text-[11px] text-muted">
                  No fields match the active legend filter.
                </p>
              )}
              {listedRows.length > 80 && (
                <p className="text-[11px] text-muted">
                  Showing first 80 of {listedRows.length} — click a parcel on the map to jump to
                  its row.
                </p>
              )}
            </div>
          </div>

          {/* ── selected field detail ──────────────────────────── */}
          {selectedField && (
            <div className="space-y-2 rounded border border-border bg-surface-2 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-text">{selectedField.id}</p>
                <Chip tone="accent">{PATTERN_CLASS_LABELS[selectedField.cls]}</Chip>
              </div>
              {selectedField.series ? (
                <SeriesSparkline series={selectedField.series} />
              ) : (
                <p className="text-xs text-muted">
                  Only {selectedField.validMonths} valid month
                  {selectedField.validMonths === 1 ? "" : "s"} — curve unavailable.
                </p>
              )}
              {selectedField.metrics && (
                <dl className="grid grid-cols-2 gap-x-3 text-[11px]">
                  <dt className="text-muted">Mean NDVI</dt>
                  <dd className="mono-nums text-right text-text">
                    {selectedField.metrics.mean.toFixed(2)}
                  </dd>
                  <dt className="text-muted">Peak month</dt>
                  <dd className="mono-nums text-right text-text">
                    {pattern.months[selectedField.metrics.peakMonth] ?? "—"}
                  </dd>
                  <dt className="text-muted">Valid months</dt>
                  <dd className="mono-nums text-right text-text">{selectedField.validMonths}</dd>
                </dl>
              )}
            </div>
          )}

          {/* ── small multiples: mean curve per pattern / group ─── */}
          {classMeans.length > 0 && (
            <div className="space-y-2 border-t border-border pt-2.5">
              <h4 className="section-label">Mean NDVI by pattern</h4>
              <div className="grid grid-cols-2 gap-2">
                {classMeans.map((row) => (
                  <figure key={row.key} className="space-y-1">
                    <figcaption
                      className="flex items-center gap-1 truncate text-[10px] text-muted"
                      title={`${row.n} field${row.n === 1 ? "" : "s"}`}
                    >
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-sm"
                        style={{ background: patternClassColor(row.cls ?? "unclassified") }}
                      />
                      <span className="truncate">
                        {PATTERN_CLASS_LABELS[row.cls ?? "unclassified"]}
                      </span>
                      <span className="mono-nums shrink-0">n={row.n}</span>
                    </figcaption>
                    <SeriesSparkline
                      series={row.mean}
                      ariaLabel={`Mean 12-month NDVI — ${
                        PATTERN_CLASS_LABELS[row.cls ?? "unclassified"]
                      }`}
                    />
                  </figure>
                ))}
              </div>
              {groupMeans.length > 0 && (
                <>
                  <h4 className="section-label">Mean NDVI by group</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {groupMeans.map((row) => (
                      <figure key={row.key} className="space-y-1">
                        <figcaption
                          className="flex items-center gap-1 truncate text-[10px] text-muted"
                          title={`${row.n} field${row.n === 1 ? "" : "s"}`}
                        >
                          <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-sm"
                            style={{ background: groupColor(row.group ?? 0) }}
                          />
                          <span>Group {row.group}</span>
                          <span className="mono-nums shrink-0">n={row.n}</span>
                        </figcaption>
                        <SeriesSparkline
                          series={row.mean}
                          ariaLabel={`Mean 12-month NDVI — group ${row.group}`}
                        />
                      </figure>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── attribution ──────────────────────────────────────────── */}
      <section className="space-y-1.5 border-t border-border pt-3">
        <p className="text-[10px] leading-relaxed text-muted">{FIELDS_ATTRIBUTION_VECTORS}</p>
        {confidenceAvailable && (
          <p className="text-[10px] leading-relaxed text-muted">{FIELDS_ATTRIBUTION_CONFIDENCE}</p>
        )}
        <p className="text-[10px] leading-relaxed text-muted">
          Cropping classes describe seasonal NDVI shape only — never crop species. Rules: fallow /
          kharif / rabi / double-cropped / zaid / evergreen.
        </p>
      </section>
    </div>
  );
}
