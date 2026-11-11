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
import { cn } from "@/components/ui/cn";
import { bboxAreaKm2 } from "@/lib/cdse/geometry";
import {
  FIELDS_ATTRIBUTION_CONFIDENCE,
  FIELDS_ATTRIBUTION_VECTORS,
} from "@/lib/fields/config";
import {
  PATTERN_CLASS_LABELS,
  patternClassColor,
  presentPatternClasses,
} from "@/lib/fields/colors";
import { getMainMap } from "@/lib/compare/bridge";
import type { BBox } from "@/lib/data";
import { useFieldsStore } from "@/store/useFieldsStore";

/** Viewport bbox from the main map (null before the map is ready). */
function viewportBBox(): BBox | null {
  const map = getMainMap();
  if (!map) return null;
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

function formatHa(m2: number): string {
  const ha = m2 / 10_000;
  if (ha >= 100) return `${Math.round(ha).toLocaleString("en")} ha`;
  return `${ha.toLocaleString("en", { maximumFractionDigits: 1 })} ha`;
}

/** Tiny 12-point NDVI sparkline (no chart library). */
function SeriesSparkline({ series }: { series: number[] }) {
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
      aria-label="12-month NDVI curve"
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

/**
 * Fields & cropping pattern sidebar (Phase 3): load parcel boundaries for the
 * current map viewport, then run the 12-month NDVI pattern classification and
 * inspect per-field curves. Everything stops at ≤25 km² (PU budget).
 */
export default function FieldsPanel() {
  const year = useFieldsStore((s) => s.year);
  const minConfidence = useFieldsStore((s) => s.minConfidence);
  const grouping = useFieldsStore((s) => s.grouping);
  const setYear = useFieldsStore((s) => s.setYear);
  const setMinConfidence = useFieldsStore((s) => s.setMinConfidence);
  const setGrouping = useFieldsStore((s) => s.setGrouping);
  const visible = useFieldsStore((s) => s.visible);
  const toggleVisible = useFieldsStore((s) => s.toggleVisible);

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

  const [pendingArea, setPendingArea] = useState<number | null>(null);

  const selectedField = useMemo(() => {
    if (!pattern || !selectedFieldId) return null;
    return pattern.fields.find((row) => row.id === selectedFieldId) ?? null;
  }, [pattern, selectedFieldId]);

  const classRows = pattern ? presentPatternClasses(pattern.classes) : [];

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
    const bbox = viewportBBox();
    if (!bbox) return;
    setPendingArea(bboxAreaKm2(bbox));
    void loadFields(bbox);
  };

  const canRunPattern = Boolean(fields && count > 0 && !patternRunning && !loading);
  const areaTooLarge = pendingArea !== null && pendingArea > 25 && !fields;

  return (
    <div className="space-y-5 p-3">
      {/* ── controls ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="section-label">Selection</h3>
        <p className="text-xs text-muted">
          Zoom the map to a small area (≤&nbsp;25&nbsp;km²), then load field boundaries for the
          current viewport.
        </p>

        <div className="space-y-2">
          <label className="text-xs text-muted" htmlFor="fields-year">
            Agri year
          </label>
          <Segmented
            ariaLabel="Agri year"
            value={String(year)}
            onChange={(value) => setYear(value === "2025" ? 2025 : 2024)}
            options={[
              { value: "2024", label: "2024–25" },
              { value: "2025", label: "2025–26" },
            ]}
          />
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
          disabled={loading || patternRunning}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Target size={14} />}
          {loading ? "Loading fields…" : "Load fields for viewport"}
        </Button>

        {areaTooLarge && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            Viewport is {pendingArea.toFixed(1)} km² — zoom in until it is under 25 km².
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

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Total area</dt>
            <dd className="mono-nums text-right text-text">{formatHa(totalAreaM2)}</dd>
            <dt className="text-muted">Viewport</dt>
            <dd className="mono-nums text-right text-text">
              {selectedAreaKm2 !== null ? `${selectedAreaKm2.toFixed(2)} km²` : "—"}
            </dd>
            <dt className="text-muted">Confidence</dt>
            <dd className="text-right text-text">
              {confidenceAvailable ? `≥ ${minConfidence}` : "unavailable"}
            </dd>
          </dl>

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
        </section>
      )}

      {/* ── pattern result ───────────────────────────────────────── */}
      {pattern && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Sprout size={14} className="text-accent" />
            <h3 className="section-label">Cropping pattern</h3>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {classRows.map(({ cls, count: classCount }) => (
              <Chip key={cls} tone="neutral" className="gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: patternClassColor(cls) }}
                />
                {PATTERN_CLASS_LABELS[cls]}
                <span className="mono-nums text-muted">{classCount}</span>
              </Chip>
            ))}
            {classRows.length === 0 && (
              <p className="text-xs text-muted">No classified fields in this selection.</p>
            )}
          </div>

          <p className="mono-nums text-[11px] text-muted">
            {pattern.count} field{pattern.count === 1 ? "" : "s"} · est. {pattern.estimatedPu} PU ·{" "}
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
              {pattern.fields.slice(0, 80).map((row) => {
                const active = row.id === selectedFieldId;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => selectField(active ? null : row.id)}
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
              {pattern.fields.length > 80 && (
                <p className="text-[11px] text-muted">
                  Showing first 80 of {pattern.fields.length} — click a parcel on the map list
                  above after zooming.
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
