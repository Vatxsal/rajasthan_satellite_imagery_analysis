"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, FileJson, Info, Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import Slider from "@/components/ui/Slider";
import Tooltip from "@/components/ui/Tooltip";
import FeatureLock, { useLocked } from "@/components/ui/FeatureLock";
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

/** "Sentinel-2C" from whatever casing the catalogue reported. */
function satelliteName(raw: string): string {
  const match = raw.match(/^sentinel-?2([abc])$/i);
  if (match) return `Sentinel-2${match[1]!.toUpperCase()}`;
  if (/^sentinel-?2$/i.test(raw)) return "Sentinel-2";
  return raw;
}

/** "+0.20" / "−0.15" — sign always visible, minus is U+2212. */
function fmtDelta(value: number): string {
  return `${value >= 0 ? "+" : "\u2212"}${Math.abs(value).toFixed(2)}`;
}

function ha(value: number): string {
  return `${value.toLocaleString("en", { maximumFractionDigits: 1 })} ha`;
}

/** Analysed-area formatting per spec: whole hectares, no decimals. */
function haRound(value: number): string {
  return `${Math.round(value).toLocaleString("en")} ha`;
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

/** Label-left / value-right row for the Method & settings card (single column). */
function MethodRow({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="shrink-0 text-muted" title={title}>
        {label}
      </dt>
      <dd className="mono-nums min-w-0 text-right text-text">{children}</dd>
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
  const dateA = useCompareStore((s) => s.dateA);
  const dateB = useCompareStore((s) => s.dateB);
  const sensitivity = useCompareStore((s) => s.sensitivity);
  const minPatchHa = useCompareStore((s) => s.minPatchHa);
  const inputMode = useCompareStore((s) => s.inputMode);
  const setInputMode = useCompareStore((s) => s.setInputMode);
  const setSensitivity = useCompareStore((s) => s.setSensitivity);
  const setMinPatchHa = useCompareStore((s) => s.setMinPatchHa);
  const lockedSensitivity = useLocked("compare.adjust-sensitivity");
  const lockedMinPatch = useLocked("compare.adjust-min-patch");
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
  // Method & settings card: top section always visible; controls + thresholds
  // start collapsed (default = top section only expanded).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [patchDraft, setPatchDraft] = useState<string | null>(null);
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
  // The card shows the analysed (frozen) pair — the header, Scene rows and
  // Date gap all read result.stats.metadata. Changing the store dates after a
  // run only marks the card stale; it can never desync the displayed pair.
  const pairChanged =
    (dateA !== null && dateA !== metadata.dateA) || (dateB !== null && dateB !== metadata.dateB);
  const stale =
    metadata.sensitivity !== sensitivity ||
    Math.abs(metadata.minPatchHa - minPatchHa) > 1e-9 ||
    (v2 && metadata.inputMode !== inputMode) ||
    pairChanged;

  const engineLabel =
    metadata.engine === "v2"
      ? `v2 · ${metadata.inputMode === "composite" ? `±${metadata.compositeWindowDays} d composite` : "single-day"}`
      : "v1 · single-day";

  const t = metadata.thresholds;
  const mainThresholdRows: Array<{ label: string; value: string }> = [
    { label: "Water gain", value: `ΔMNDWI ≥ ${fmtDelta(t.waterGainDMndwi ?? 0)}` },
    { label: "Water loss", value: `ΔMNDWI ≤ ${fmtDelta(t.waterLossDMndwi ?? 0)}` },
    { label: "Vegetation loss", value: `ΔNDVI ≤ ${fmtDelta(t.vegLossDNdvi ?? 0)}` },
    { label: "Vegetation gain", value: `ΔNDVI ≥ ${fmtDelta(t.vegGainDNdvi ?? 0)}` },
    {
      label: "Bare / built-up increase",
      value: `ΔNDBI ≥ ${fmtDelta(t.bareBuiltDNdbi ?? 0)} and ΔNDVI ≤ ${fmtDelta(t.bareBuiltDNdviMax ?? 0)}`,
    },
  ];
  const advancedThresholdRows: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "Bare / built-up max MNDWI",
      value: `≤ ${(t.bareBuiltMaxMndwi ?? 0).toFixed(2)}`,
      hint: "Skips pixels that look like open water on either date.",
    },
    {
      label: "Water gain min MNDWI",
      value: `> ${(t.waterGainMndwiMin ?? 0).toFixed(2)}`,
      hint: "Date B must actually look like open water for a water-gain patch.",
    },
    {
      label: "Water loss min MNDWI",
      value: `> ${(t.waterLossMndwiMin ?? 0).toFixed(2)}`,
      hint: "Date A must have looked like open water for a water-loss patch.",
    },
    {
      label: "Grid size (px)",
      value: `${metadata.width}×${metadata.height}`,
      hint: "Analysis grid actually rendered — the long side is capped for large areas.",
    },
  ];

  /** Commits the minimum-patch text input (blur / Enter) with clamping. */
  const commitPatchDraft = (): void => {
    if (patchDraft === null) return;
    const parsed = Number(patchDraft);
    if (patchDraft.trim() !== "" && Number.isFinite(parsed)) {
      setMinPatchHa(Math.min(10, Math.max(0.01, parsed)));
    }
    setPatchDraft(null);
  };

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
              Minimum confidence — defaults to Medium+; High = strongest multi-evidence patches only
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
            const confidencePct =
              typeof props.confidencePct === "number" && Number.isFinite(props.confidencePct)
                ? Math.round(props.confidencePct)
                : null;
            const subLabel =
              typeof props.subLabel === "string" && props.subLabel ? props.subLabel : null;
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
                    <span className="min-w-0 flex-1 text-xs text-text">
                      <span className="block truncate">{classLabel}</span>
                      {subLabel && (
                        <span className="block truncate text-[10px] text-muted">{subLabel}</span>
                      )}
                    </span>
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
                        {confidencePct !== null ? ` · ${confidencePct}%` : ""}
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
      <div aria-label="Method and settings" className="rounded border border-border bg-surface-2 p-2.5">
        {/* Header: title + engine badge + chevron (toggles sections 2–3) */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="text-xs font-medium text-text">Method &amp; settings</p>
            <span
              className="mono-nums shrink-0 rounded-sm border border-border bg-surface px-1.5 py-px text-[10px] text-muted"
              title="Change engine that produced this result."
            >
              {engineLabel}
            </span>
          </div>
          <button
            type="button"
            aria-expanded={settingsOpen}
            aria-label={settingsOpen ? "Collapse controls and thresholds" : "Expand controls and thresholds"}
            onClick={() => setSettingsOpen((open) => !open)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded border border-transparent text-muted transition-colors duration-150 hover:border-border hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <ChevronDown
              size={14}
              className={cn("transition-transform duration-150", settingsOpen && "rotate-180")}
              aria-hidden
            />
          </button>
        </div>

        {/* Section 1 — always visible facts (same normalized pair as the header) */}
        <dl className="mt-2 flex flex-col gap-1 text-[11px]">
          <MethodRow label="Resolution">
            <span className="inline-flex flex-wrap items-baseline justify-end gap-1.5">
              <span>{metadata.metersPerPixel.toFixed(1)} m/px</span>
              {metadata.coarse && (
                <Tooltip
                  content="Large area analysed on a capped grid; choose a tehsil for finer detail"
                  side="top"
                >
                  <span
                    tabIndex={0}
                    className="rounded-sm border border-warning/40 bg-warning/10 px-1 py-px text-[10px] text-warning"
                  >
                    coarse
                  </span>
                </Tooltip>
              )}
            </span>
          </MethodRow>
          <MethodRow label="Analysed area">{haRound(stats.areaHa)}</MethodRow>
          <MethodRow label="Valid data">{stats.validPct.toFixed(1)}% of the area</MethodRow>
          <MethodRow label="Date gap">{metadata.gapDays} days</MethodRow>
          <MethodRow label="Scene A">
            {metadata.dateA}
            {metadata.sceneA
              ? ` · ${satelliteName(metadata.sceneA.satellite)} · ${Math.round(metadata.sceneA.cloudCover)}% cloud`
              : ""}
          </MethodRow>
          <MethodRow label="Scene B">
            {metadata.dateB}
            {metadata.sceneB
              ? ` · ${satelliteName(metadata.sceneB.satellite)} · ${Math.round(metadata.sceneB.cloudCover)}% cloud`
              : ""}
          </MethodRow>
          {v2 && (
            <MethodRow label="Estimated cost" title="Processing Units for both renders (CDSE formula).">
              {metadata.estimatedPu} PU
            </MethodRow>
          )}
          {v2 && stats.confidence && (
            <MethodRow label="Confidence" title="Share of changed pixels per confidence tier.">
              {confidenceShares(stats.confidence)}
            </MethodRow>
          )}
          {metadata.rules && (
            <MethodRow label="Rules" title="Change-rule mode (CHANGE_RULES) that produced this result.">
              {metadata.rules === "fused"
                ? "fused · evidence-scored"
                : metadata.rules === "ml"
                  ? "ml · trained model"
                  : "legacy · shipped thresholds"}
            </MethodRow>
          )}
          {metadata.evidence && (
            <>
              <MethodRow
                label="SAR"
                title={
                  metadata.evidence.s1 && "orbit" in metadata.evidence.s1 && metadata.evidence.s1WindowDays
                    ? `Sentinel-1 GRD temporal median within ±${metadata.evidence.s1WindowDays} days of ${metadata.dateA} and ${metadata.dateB} (one orbit direction per side).`
                    : "Sentinel-1 GRD evidence (one orbit direction per side)."
                }
              >
                {!metadata.evidence.s1
                  ? "off"
                  : "orbit" in metadata.evidence.s1
                    ? `Sentinel-1 ${metadata.evidence.s1.orbit}${
                        metadata.evidence.s1WindowDays
                          ? ` · ±${metadata.evidence.s1WindowDays} d median`
                          : ""
                      }`
                    : `unavailable (${metadata.evidence.s1.skipped})`}
              </MethodRow>
              <MethodRow
                label="Prior"
                title="ESA WorldCover 2021 land-cover before date A gates new built-up/water."
              >
                {metadata.evidence.worldCover ? "WorldCover 2021" : "off"}
              </MethodRow>
              <MethodRow
                label="Terrain"
                title="Copernicus DEM hillshade-shadow mask suppresses false water."
              >
                {metadata.evidence.terrain && metadata.evidence.demInstance
                  ? `${metadata.evidence.demInstance} shadow mask`
                  : "off"}
              </MethodRow>
            </>
          )}
        </dl>
        {pairChanged && !running && (
          <p className="mt-1.5 text-[10px] text-warning">
            The selected dates changed since this run — the rows above show the analysed pair.
          </p>
        )}

        {/* Sections 2–3 behind the header chevron (default: top section only) */}
        {settingsOpen && (
          <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
            {/* Section 2 — controls, one full-width row each */}
            <div className="flex flex-col gap-2.5">
              {v2 && (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] text-muted">
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
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted">Sensitivity</p>
                  <FeatureLock capability="compare.adjust-sensitivity" label="Adjust sensitivity" />
                </div>
                <Segmented
                  ariaLabel="Change detection sensitivity"
                  value={sensitivity}
                  onChange={(value) => {
                    if (lockedSensitivity) return;
                    setSensitivity(value as Sensitivity);
                  }}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                  ]}
                  className={lockedSensitivity ? "pointer-events-none opacity-50" : undefined}
                />
                <p className="text-[10px] text-muted">
                  {lockedSensitivity
                    ? "Guests run at the default sensitivity — sign in to adjust."
                    : "Low = fewer, stronger changes · Medium = balanced · High = more, weaker changes"}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="min-patch-ha" className="text-[11px] text-muted">
                    Minimum patch
                  </label>
                  <span className="flex items-center gap-1">
                    <input
                      id="min-patch-ha"
                      type="text"
                      inputMode="decimal"
                      value={patchDraft ?? minPatchHa.toFixed(2)}
                      onChange={(event) => {
                        if (lockedMinPatch) return;
                        setPatchDraft(event.target.value);
                      }}
                      onBlur={commitPatchDraft}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitPatchDraft();
                      }}
                      disabled={lockedMinPatch}
                      aria-label="Minimum patch size in hectares"
                      className="mono-nums w-16 rounded border border-border bg-surface px-1.5 py-0.5 text-right text-[11px] text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-50"
                    />
                    <span className="text-[11px] text-muted">ha</span>
                    <FeatureLock capability="compare.adjust-min-patch" label="Adjust minimum patch" />
                  </span>
                </div>
                <Slider
                  aria-label="Minimum patch slider"
                  min={0.01}
                  max={10}
                  step={0.01}
                  value={minPatchHa}
                  disabled={lockedMinPatch}
                  onChange={(event) => {
                    if (lockedMinPatch) return;
                    setMinPatchHa(Number(event.target.value));
                  }}
                />
              </div>
              <Button
                variant="primary"
                disabled={running}
                className="w-full"
                title="Runs the analysis again with the current settings (new result)."
                onClick={() => void run()}
              >
                {running && stage ? "Working…" : stale ? "Re-run with settings" : "Re-run"}
              </Button>
              {running && (
                <p className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                  Re-running the analysis…
                </p>
              )}
            </div>

            {/* Section 3 — thresholds used (accordion, default closed) */}
            <div className="rounded border border-border bg-surface px-2 py-1.5">
              <button
                type="button"
                aria-expanded={thresholdsOpen}
                onClick={() => setThresholdsOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-2 text-[11px] font-medium text-text transition-colors duration-150 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              >
                Thresholds used
                <ChevronDown
                  size={13}
                  className={cn("text-muted transition-transform duration-150", thresholdsOpen && "rotate-180")}
                  aria-hidden
                />
              </button>
              {thresholdsOpen && (
                <div className="mt-2 flex flex-col gap-2">
                  <dl className="flex flex-col gap-1 text-[11px]">
                    {mainThresholdRows.map((row) => (
                      <MethodRow key={row.label} label={row.label}>
                        {row.value}
                      </MethodRow>
                    ))}
                  </dl>
                  <div className="rounded border border-border bg-surface-2 px-2 py-1.5">
                    <button
                      type="button"
                      aria-expanded={advancedOpen}
                      onClick={() => setAdvancedOpen((open) => !open)}
                      className="flex w-full items-center justify-between gap-2 text-[11px] text-text transition-colors duration-150 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                    >
                      Advanced
                      <ChevronDown
                        size={13}
                        className={cn("text-muted transition-transform duration-150", advancedOpen && "rotate-180")}
                        aria-hidden
                      />
                    </button>
                    {advancedOpen && (
                      <div className="mt-2 flex flex-col gap-1.5 text-[11px]">
                        {advancedThresholdRows.map((row) => (
                          <div key={row.label} className="flex flex-col gap-0.5">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                              <span className="shrink-0 text-muted">{row.label}</span>
                              <span className="mono-nums min-w-0 text-right text-text">{row.value}</span>
                            </div>
                            <p className="text-[10px] leading-snug text-muted">{row.hint}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
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
