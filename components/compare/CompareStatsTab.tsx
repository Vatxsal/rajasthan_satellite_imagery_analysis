"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, FileJson, Info, Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import Slider from "@/components/ui/Slider";
import { cn } from "@/components/ui/cn";
import { focusHotspot, focusTehsil } from "@/lib/compare/bridge";
import { eventsViewState, selectVisibleEvents } from "@/lib/compare/eventList";
import { downloadEventsGeoJson, downloadStatsCsv } from "@/lib/compare/export";
import { analysisParamsQuery } from "@/lib/compare/params";
import type { CompareStats, ConfidenceTier } from "@/lib/analysis/types";
import type { Sensitivity } from "@/lib/analysis/config";
import { classColor } from "@/lib/analysis/config";
import { useCompareStore, type CompareInputMode } from "@/store/useCompareStore";
import { useAppStore } from "@/store/useAppStore";

const THRESHOLD_LABELS: Record<string, string> = {
  waterGainDMndwi: "ΔMNDWI water gain ≥",
  waterLossDMndwi: "ΔMNDWI water loss ≤",
  vegLossDNdvi: "ΔNDVI vegetation loss ≤",
  vegGainDNdvi: "ΔNDVI vegetation gain ≥",
  bareBuiltDNdbi: "ΔNDBI bare / built ≥",
  bareBuiltDNdviMax: "ΔNDVI max (bare / built) ≤",
};

function ha(value: number): string {
  return `${value.toLocaleString("en", { maximumFractionDigits: 1 })} ha`;
}

function rgb(color: [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/** "high 62% · med 30% · low 8%" from per-tier changed-pixel counts. */
function confidenceShares(counts: { high: number; medium: number; low: number }): string {
  const total = counts.high + counts.medium + counts.low;
  if (total <= 0) return "—";
  const pct = (n: number): number => Math.round((n / total) * 100);
  return `high ${pct(counts.high)}% · med ${pct(counts.medium)}% · low ${pct(counts.low)}%`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mono-nums text-sm font-medium text-text">{value}</p>
      {hint && <p className="mono-nums text-[10px] text-muted">{hint}</p>}
    </div>
  );
}

/** Small copy-to-clipboard icon button (shows a brief "Copied" state). */
function CopyCoordsButton({ coords }: { coords: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Centroid copied" : "Copy centroid coordinates"}
      title="Copy centroid"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(coords).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded border border-transparent text-muted opacity-0 transition-all duration-150",
        "hover:border-border hover:bg-surface hover:text-text",
        "group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
        copied && "text-success opacity-100",
      )}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

interface CompareStatsTabProps {
  tab: "statistics" | "hotspots";
}

/** Statistics + events tabs (the drawer renders this for both). */
export default function CompareStatsTab({ tab }: CompareStatsTabProps) {
  const result = useCompareStore((s) => s.result);
  const sensitivity = useCompareStore((s) => s.sensitivity);
  const minPatchHa = useCompareStore((s) => s.minPatchHa);
  const inputMode = useCompareStore((s) => s.inputMode);
  const setInputMode = useCompareStore((s) => s.setInputMode);
  const setSensitivity = useCompareStore((s) => s.setSensitivity);
  const setMinPatchHa = useCompareStore((s) => s.setMinPatchHa);
  const running = useCompareStore((s) => s.running);
  const stage = useCompareStore((s) => s.stage);
  const run = useCompareStore((s) => s.run);
  const choropleth = useCompareStore((s) => s.choropleth);
  const toggleChoropleth = useCompareStore((s) => s.toggleChoropleth);
  const tehsilHighlight = useCompareStore((s) => s.tehsilHighlight);
  const setTehsilHighlight = useCompareStore((s) => s.setTehsilHighlight);
  const hoveredHotspot = useCompareStore((s) => s.hoveredHotspot);
  const setHoveredHotspot = useCompareStore((s) => s.setHoveredHotspot);
  const selectedHotspot = useCompareStore((s) => s.selectedHotspot);
  const setSelectedHotspot = useCompareStore((s) => s.setSelectedHotspot);
  const confidenceFilter = useCompareStore((s) => s.confidenceFilter);
  const setConfidenceFilter = useCompareStore((s) => s.setConfidenceFilter);
  const eventsItems = useCompareStore((s) => s.eventsItems);
  const eventsTotal = useCompareStore((s) => s.eventsTotal);
  const eventsFilteredTotal = useCompareStore((s) => s.eventsFilteredTotal);
  const eventsLimit = useCompareStore((s) => s.eventsLimit);
  const eventsStatus = useCompareStore((s) => s.eventsStatus);
  const eventsError = useCompareStore((s) => s.eventsError);
  const loadMoreEvents = useCompareStore((s) => s.loadMoreEvents);

  // Slow-load hint: a cold server cache recomputes the analysis for the next
  // page/overlay — tell the user instead of spinning silently.
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (tab !== "hotspots" || eventsStatus !== "loading") {
      setSlowLoad(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoad(true), 1500);
    return () => window.clearTimeout(timer);
  }, [tab, eventsStatus]);

  if (!result) return null;
  const stats: CompareStats = result.stats;
  const { metadata } = stats;
  const lowValid = stats.validPct < 70;
  const v2 = metadata.engine === "v2";
  const stale =
    metadata.sensitivity !== sensitivity ||
    Math.abs(metadata.minPatchHa - minPatchHa) > 1e-9 ||
    (v2 && metadata.inputMode !== inputMode);

  if (tab === "hotspots") {
    const loading = eventsStatus === "loading";
    // One source for list rows AND map markers (bridge reads the same helper).
    const visible = selectVisibleEvents(eventsItems, { confidenceFilter, limit: eventsLimit });
    const view = eventsViewState({ status: eventsStatus, error: eventsError, visibleCount: visible.length });
    // The retry banner rides on the status alone — an error with rows already
    // loaded keeps the list (header + rows) while still offering the retry.
    const showError = eventsStatus === "error";
    const errorMessage = (eventsError ?? "").trim() || "Change events failed to load.";
    // Header count: exact raw total, or the probed filtered total when a
    // confidence filter is active (falls back to the visible rows while the
    // probe is still in flight — never a bogus "0 patches").
    const headerTotal = confidenceFilter !== null ? (eventsFilteredTotal ?? visible.length) : eventsTotal;
    const hasMore = visible.length < headerTotal;

    return (
      <div className="flex flex-col gap-2">
        {view.kind === "list" && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted">
              Change events — {headerTotal.toLocaleString("en")}{" "}
              {headerTotal === 1 ? "patch" : "patches"}
              {confidenceFilter ? ` matching ${confidenceFilter} confidence` : ""}, largest first.
              Click one to zoom the map.
            </p>
            <Button
              size="sm"
              disabled={loading}
              title="Download every change event as one GeoJSON file (paged from the server)."
              onClick={() => {
                void downloadEventsGeoJson(
                  result.key,
                  { dateA: metadata.dateA, dateB: metadata.dateB },
                  analysisParamsQuery(metadata),
                ).catch((error: unknown) => {
                  const message =
                    error instanceof Error && error.message
                      ? error.message
                      : "The events file is unavailable.";
                  useAppStore.getState().pushToast({ tone: "error", message, duration: 5000 });
                });
              }}
            >
              <FileJson size={13} />
              GeoJSON
            </Button>
          </div>
        )}

        {v2 && (
          <div>
            <p className="mb-1 text-[11px] text-muted">
              Minimum confidence — high = strongest multi-evidence patches only
            </p>
            <Segmented
              ariaLabel="Minimum event confidence"
              value={confidenceFilter ?? "all"}
              onChange={(value) =>
                setConfidenceFilter(value === "all" ? null : (value as ConfidenceTier))
              }
              options={[
                { value: "all", label: "All" },
                { value: "high", label: "High" },
                { value: "medium", label: "Medium" },
                { value: "low", label: "Low" },
              ]}
            />
          </div>
        )}

        {showError && (
          <div className="flex flex-col gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-3">
            <p className="text-xs text-text">{errorMessage}</p>
            <Button
              size="sm"
              className="self-start"
              disabled={loading}
              onClick={() => {
                // Loaded rows → just retry the page; nothing loaded → the full
                // analysis re-run refreshes every tab.
                if (eventsItems.length > 0) void loadMoreEvents();
                else void run();
              }}
            >
              Retry
            </Button>
          </div>
        )}

        {view.kind === "empty" && (
          <div className="flex flex-col gap-1 rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            <p>
              {confidenceFilter
                ? "No events match this confidence filter."
                : "No significant change events at these settings."}
            </p>
            {!confidenceFilter && (
              <p>
                Try lowering the minimum patch size or raising the sensitivity in the Statistics
                tab, then re-run the analysis.
              </p>
            )}
          </div>
        )}

        {view.kind === "loading" && (
          <p className="flex items-center gap-1.5 rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {slowLoad ? "Re-running analysis… (this can take up to a minute)" : "Loading events…"}
          </p>
        )}

        <ol className="flex flex-col gap-1">
          {visible.map((event, index) => {
            const props = (event.properties ?? {}) as Record<string, unknown>;
            const classCode = Number(props.classCode ?? -1);
            const color = classColor(classCode);
            const classLabel = String(props.classLabel ?? "Change");
            const areaHa = Number(props.areaHa ?? 0);
            const confidence = props.confidence as ConfidenceTier | undefined;
            const centroid = (props.centroid as number[] | undefined) ?? [0, 0];
            const bboxProps = props.bbox as number[] | undefined;
            const lon = centroid[0];
            const lat = centroid[1];
            // Focus bbox: the patch's own edges; fallback rings the centroid.
            const bbox: [number, number, number, number] =
              bboxProps && bboxProps.length === 4
                ? [bboxProps[0], bboxProps[1], bboxProps[2], bboxProps[3]]
                : [lon - 0.002, lat - 0.002, lon + 0.002, lat + 0.002];
            const rank = index + 1;
            const selected = selectedHotspot === rank;
            const hovered = hoveredHotspot === rank;
            const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
            return (
              <li
                key={String(event.id ?? `ev-${index}`)}
                className={cn(
                  "group flex items-stretch gap-1 rounded border transition-colors duration-150",
                  selected ? "border-accent" : hovered ? "border-accent/50" : "border-border",
                )}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  onMouseEnter={() => setHoveredHotspot(rank)}
                  onMouseLeave={() => setHoveredHotspot(null)}
                  onFocus={() => setHoveredHotspot(rank)}
                  onBlur={() => setHoveredHotspot(null)}
                  onClick={() => {
                    setSelectedHotspot(rank);
                    focusHotspot(rank, bbox);
                  }}
                  title="Zoom to this event and open its map popup"
                  className={cn(
                    "flex min-w-0 flex-1 flex-col gap-1 rounded-l-[5px] px-2 py-1.5 text-left transition-colors duration-150",
                    hovered || selected ? "bg-surface-2" : "bg-surface hover:bg-surface-2",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="mono-nums grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-[10px] font-semibold text-text">
                      {rank}
                    </span>
                    <span
                      className="h-3 w-3 shrink-0 rounded-sm border border-border"
                      style={{ background: rgb(color) }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-text">{classLabel}</span>
                    <span className="mono-nums ml-auto shrink-0 whitespace-nowrap text-[11px] text-text">
                      {areaHa.toLocaleString("en", { maximumFractionDigits: 1 })} ha
                    </span>
                  </span>
                  <span className="flex items-center gap-2 pl-7 text-[10px] text-muted">
                    {confidence && (
                      <span
                        className={cn(
                          "shrink-0 rounded-sm border px-1 py-px",
                          confidence === "high"
                            ? "border-success/40 text-success"
                            : confidence === "medium"
                              ? "border-warning/40 text-warning"
                              : "border-border text-muted",
                        )}
                        title="Majority confidence tier of this patch's pixels"
                      >
                        {confidence}
                      </span>
                    )}
                    <span className="mono-nums ml-auto shrink-0 whitespace-nowrap">{coords}</span>
                  </span>
                </button>
                <div className="flex items-center pr-1">
                  <CopyCoordsButton coords={`${lat.toFixed(6)}, ${lon.toFixed(6)}`} />
                </div>
              </li>
            );
          })}
        </ol>

        {view.kind === "list" && hasMore && (
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => void loadMoreEvents()}
          >
            {loading && (
              <Loader2 size={13} className="animate-spin" aria-hidden />
            )}
            {loading
              ? slowLoad
                ? "Re-running analysis…"
                : "Loading…"
              : `Load more (${visible.length.toLocaleString("en")} of ${headerTotal.toLocaleString("en")})`}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {lowValid && (
        <p className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-text">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          Only {stats.validPct.toFixed(0)}% of the area has usable data (cloud / no-data masking) —
          treat the totals as a partial picture.
        </p>
      )}
      {stats.negligible && (
        <p className="flex items-start gap-2 rounded border border-border bg-surface-2 px-2.5 py-2 text-xs text-text">
          <Info size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          No significant change survived the thresholds and minimum patch size for this pair. Try
          High sensitivity or a smaller minimum patch below.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Metric
          label="Changed area"
          value={ha(stats.changedHa)}
          hint={`${(stats.changedHa / 100).toFixed(2)} km²`}
        />
        <Metric label="Valid data" value={`${stats.validPct.toFixed(1)}%`} hint={`of ${ha(stats.areaHa)}`} />
      </div>

      {/* ---------------------------------------------------- class breakdown */}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-[11px] text-muted">
              <th className="px-2 py-1.5 font-medium">Class</th>
              <th className="px-2 py-1.5 text-right font-medium">Area</th>
              <th className="px-2 py-1.5 text-right font-medium">km²</th>
              <th className="px-2 py-1.5 text-right font-medium">% of valid</th>
            </tr>
          </thead>
          <tbody>
            {stats.classes.map((cls) => (
              <tr key={cls.code} className="border-b border-border last:border-0">
                <td className="px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm border border-border"
                      style={{ background: rgb(cls.color) }}
                      aria-hidden
                    />
                    {cls.label}
                  </span>
                </td>
                <td className="mono-nums px-2 py-1.5 text-right">{ha(cls.areaHa)}</td>
                <td className="mono-nums px-2 py-1.5 text-right">{cls.areaKm2.toFixed(2)}</td>
                <td className="mono-nums px-2 py-1.5 text-right">{cls.pctOfValid.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------------------------------------------- per-tehsil */}
      {stats.tehsils && stats.tehsils.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted">
              Click a tehsil to highlight it on the map.
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={choropleth}
              onClick={toggleChoropleth}
              className={cn(
                "inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] transition-colors duration-150",
                choropleth ? "bg-surface-2 text-text" : "bg-surface text-muted hover:text-text",
              )}
              title="Shade every tehsil by changed area (alpha ∝ √changed)."
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-sm border border-border"
                style={{ background: "rgba(37, 99, 235, 0.45)" }}
              />
              Tehsil shading
            </button>
          </div>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-left text-[11px] text-muted">
                  <th className="sticky left-0 z-10 bg-surface-2 px-2 py-1.5 font-medium">Tehsil</th>
                  <th className="px-2 py-1.5 text-right font-medium">Changed</th>
                  <th className="px-2 py-1.5 font-medium">Dominant change</th>
                </tr>
              </thead>
              <tbody>
                {stats.tehsils.map((row) => {
                  let bestCode = -1;
                  let bestPixels = 0;
                  for (const key of Object.keys(row.pixelsByClass)) {
                    const code = Number(key);
                    const pixels = row.pixelsByClass[code] ?? 0;
                    if (code > 0 && code < 6 && pixels > bestPixels) {
                      bestPixels = pixels;
                      bestCode = code;
                    }
                  }
                  const dominant =
                    bestCode >= 0 && bestPixels > 0
                      ? stats.classes.find((cls) => cls.code === bestCode)?.label ?? "—"
                      : "—";
                  const highlighted = tehsilHighlight?.id === row.tehsilId;
                  return (
                    <tr
                      key={row.tehsilId}
                      onClick={() => {
                        if (highlighted) {
                          setTehsilHighlight(null);
                          return;
                        }
                        setTehsilHighlight({ id: row.tehsilId, name: row.name });
                        focusTehsil(row.tehsilId);
                      }}
                      className={cn(
                        "group cursor-pointer border-b border-border transition-colors duration-150 last:border-0 hover:bg-surface-2",
                        highlighted && "bg-accent-soft",
                      )}
                      aria-selected={highlighted}
                      title={highlighted ? "Clear highlight" : "Highlight this tehsil on the map"}
                    >
                      <td
                        className={cn(
                          "sticky left-0 z-10 px-2 py-1.5 text-text transition-colors duration-150 group-hover:bg-surface-2",
                          highlighted && "bg-accent-soft",
                          !highlighted && "bg-surface",
                        )}
                      >
                        {row.name}
                      </td>
                      <td className="mono-nums px-2 py-1.5 text-right">{ha(row.changedHa)}</td>
                      <td className="px-2 py-1.5 text-muted">{dominant}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- method + settings */}
      <div className="rounded border border-border bg-surface-2 p-2.5">
        <p className="mb-2 text-xs font-medium text-text">Method &amp; settings</p>
        <dl className="mb-3 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Resolution</dt>
            <dd className="mono-nums text-text">
              {metadata.metersPerPixel.toFixed(1)} m/px{metadata.coarse ? " (coarse)" : ""}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Grid</dt>
            <dd className="mono-nums text-text">
              {metadata.width}×{metadata.height} px
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Analysed area</dt>
            <dd className="mono-nums text-text">
              {ha(stats.areaHa)} (valid {ha(stats.validHa)})
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Date gap</dt>
            <dd className="mono-nums text-text">{metadata.gapDays} d</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Scene A</dt>
            <dd className="mono-nums text-text">
              {metadata.sceneA
                ? `${metadata.sceneA.satellite} · ${metadata.sceneA.cloudCover.toFixed(0)}% cloud`
                : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Scene B</dt>
            <dd className="mono-nums text-text">
              {metadata.sceneB
                ? `${metadata.sceneB.satellite} · ${metadata.sceneB.cloudCover.toFixed(0)}% cloud`
                : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Engine</dt>
            <dd className="mono-nums text-text">
              {metadata.engine === "v2"
                ? `v2 · ${metadata.inputMode === "composite" ? `±${metadata.compositeWindowDays} d composite` : "single-day"}`
                : "v1 · single-day"}
            </dd>
          </div>
          {v2 && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted" title="Processing Units for both renders (CDSE formula).">
                Estimated cost
              </dt>
              <dd className="mono-nums text-text">{metadata.estimatedPu} PU</dd>
            </div>
          )}
          {v2 && stats.confidence && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted" title="Share of changed pixels per confidence tier.">
                Confidence
              </dt>
              <dd className="mono-nums text-text">{confidenceShares(stats.confidence)}</dd>
            </div>
          )}
          {Object.entries(metadata.thresholds).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-muted">{THRESHOLD_LABELS[key] ?? key}</dt>
              <dd className="mono-nums text-text">{value.toFixed(2)}</dd>
            </div>
          ))}
        </dl>

        {v2 && (
          <div>
            <p className="mb-1 text-[11px] text-muted">
              Inputs — composite smooths clouds over ±7 days; single day keeps timing detail
            </p>
            <Segmented
              ariaLabel="Engine input mode"
              value={inputMode}
              onChange={(value) => setInputMode(value as CompareInputMode)}
              options={[
                { value: "composite", label: "Composite" },
                { value: "single", label: "Single day" },
              ]}
            />
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <p className="mb-1 text-[11px] text-muted">
              Sensitivity — low = fewer, stronger changes
            </p>
            <Segmented
              ariaLabel="Change detection sensitivity"
              value={sensitivity}
              onChange={(value) => setSensitivity(value as Sensitivity)}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </div>
          <div className="flex-1">
            <p className="mb-1 flex items-center justify-between text-[11px] text-muted">
              Minimum patch
              <span className="mono-nums text-text">{minPatchHa.toFixed(2)} ha</span>
            </p>
            <Slider
              aria-label="Minimum patch size in hectares"
              min={0.01}
              max={10}
              step={0.01}
              value={minPatchHa}
              onChange={(event) => setMinPatchHa(Number(event.target.value))}
            />
          </div>
          <Button
            variant={stale ? "primary" : "secondary"}
            disabled={running}
            className="shrink-0"
            title="Runs the analysis again with the current settings (new result)."
            onClick={() => void run()}
          >
            {running && stage ? "Working…" : stale ? "Re-run with settings" : "Re-run"}
          </Button>
        </div>
        {running && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            Re-running the analysis…
          </p>
        )}
      </div>

      {/* ---------------------------------------------------- exports */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">Generated {new Date(metadata.generatedAt).toLocaleString()}</p>
        <Button size="sm" onClick={() => downloadStatsCsv(stats)}>
          Export CSV
        </Button>
      </div>

      <p className="text-[10px] leading-relaxed text-muted">
        Plain-language explanations moved to the <span className="text-text">Summary</span> tab.
      </p>
    </div>
  );
}
