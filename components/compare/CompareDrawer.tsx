"use client";

import { useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { BarChart3, Crosshair, Download, Flame, Layers3, Loader2, MoveHorizontal, Sparkles, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Slider from "@/components/ui/Slider";
import { cn } from "@/components/ui/cn";
import { downloadOverlayFile } from "@/lib/compare/export";
import { focusChangeBbox } from "@/lib/compare/bridge";
import { CLASS, CLASS_DEFS } from "@/lib/analysis/config";
import { useAppStore } from "@/store/useAppStore";
import {
  useCompareStore,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  type CompareTab,
} from "@/store/useCompareStore";
import { useIsDesktop } from "@/lib/hooks/useMediaQuery";
import CompareStatsTab from "./CompareStatsTab";
import CompareSummaryTab from "./CompareSummaryTab";
import { formatShortDate } from "./CompareBar";

const TAB_OPTIONS: Array<{ value: CompareTab; label: string; icon: LucideIcon }> = [
  { value: "swipe", label: "Swipe", icon: MoveHorizontal },
  { value: "change-map", label: "Changes", icon: Layers3 },
  { value: "statistics", label: "Stats", icon: BarChart3 },
  { value: "hotspots", label: "Hotspots", icon: Flame },
  { value: "summary", label: "Summary", icon: Sparkles },
];

/** Legend display order (change classes first, masked last, no-change below). */
const LEGEND_ORDER = [
  CLASS.vegLoss,
  CLASS.vegGain,
  CLASS.bareBuilt,
  CLASS.waterGain,
  CLASS.waterLoss,
  CLASS.masked,
];

function rgb(color: [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/** Checkerboard swatch for the (always transparent) no-change class. */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    "repeating-conic-gradient(rgba(120,120,130,.9) 0% 25%, rgba(210,210,215,.9) 0% 50%)",
  backgroundSize: "8px 8px",
};

/**
 * Finished-comparison results. Desktop (≥1024px): a resizable right-hand
 * panel sitting next to the map column (the map keeps ≥60% of the viewport
 * after the analysis collapses the left sidebar). Mobile: a bottom sheet
 * capped at 45vh above the scene strip. Both share the single-column layout;
 * the desktop panel is a container so children react to its own width.
 */
export default function CompareDrawer() {
  const open = useCompareStore((s) => s.drawerOpen);
  const result = useCompareStore((s) => s.result);
  const tab = useCompareStore((s) => s.tab);
  const running = useCompareStore((s) => s.running);
  const panelWidth = useCompareStore((s) => s.panelWidth);
  const setPanelWidth = useCompareStore((s) => s.setPanelWidth);

  const stripOpen = useAppStore((s) => s.resultsOpen);
  const searching = useAppStore((s) => s.searching);
  const hasSearched = useAppStore((s) => s.hasSearched);
  const stripHeightPx = useAppStore((s) => s.stripHeightPx);
  const isDesktop = useIsDesktop();

  if (!open || !result) return null;
  const { metadata } = result.stats;

  if (isDesktop) {
    return (
      <aside
        aria-label="Change detection results"
        className="@container relative z-40 flex shrink-0 flex-col border-l border-border bg-surface"
        style={{ width: panelWidth }}
      >
        <PanelResizeHandle width={panelWidth} onResize={setPanelWidth} />
        <DrawerHeader metadata={metadata} />
        <DrawerBody tab={tab} running={running} />
      </aside>
    );
  }

  const stripActive = searching || hasSearched;
  const bottom = stripOpen && stripActive ? stripHeightPx : 0;

  return (
    <section
      aria-label="Change detection results"
      className="@container fixed inset-x-0 bottom-0 z-40 flex max-h-[45vh] flex-col border-t border-border bg-surface shadow-float"
      style={{ bottom }}
    >
      <DrawerHeader metadata={metadata} />
      <DrawerBody tab={tab} running={running} />
    </section>
  );
}

function DrawerHeader({
  metadata,
}: {
  metadata: { areaName: string; dateA: string; dateB: string; gapDays: number };
}) {
  const setDrawerOpen = useCompareStore((s) => s.setDrawerOpen);
  return (
    <header className="flex shrink-0 flex-col gap-1 border-b border-border px-3 pt-2">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate text-xs font-medium text-text"
          title={`Change detection · ${metadata.areaName}`}
        >
          Change detection · {metadata.areaName}
        </p>
        <button
          type="button"
          aria-label="Close change detection results"
          onClick={() => setDrawerOpen(false)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          <X size={14} />
        </button>
      </div>
      <p className="mono-nums text-[11px] text-muted">
        {formatShortDate(metadata.dateA)} → {formatShortDate(metadata.dateB)}
      </p>
      <p className="pb-1 text-[11px] text-muted">
        <span className="mono-nums rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-text">
          {metadata.gapDays} day gap
        </span>
      </p>
      <CompareTabs />
    </header>
  );
}

/** Icon tab bar — never wraps; labels hide only in very narrow panels (<384px = @sm container). */
function CompareTabs() {
  const tab = useCompareStore((s) => s.tab);
  const setTab = useCompareStore((s) => s.setTab);
  return (
    <div
      role="tablist"
      aria-label="Change detection views"
      className="flex items-stretch gap-0.5 border-b border-border"
    >
      {TAB_OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = value === tab;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            onClick={() => setTab(value)}
            className={cn(
              "-mb-px flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap border-b-2 px-1 pb-1.5 pt-1 text-[11px] transition-colors duration-150",
              active ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            <Icon size={13} className="shrink-0" aria-hidden />
            <span className="truncate @max-sm:hidden">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function DrawerBody({ tab, running }: { tab: CompareTab; running: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {running && (
        <p className="mb-2 flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] text-muted">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          Updating the result… (previous result stays visible)
        </p>
      )}

      {tab === "swipe" && <SwipeHelp />}
      {tab === "change-map" && <ChangeMapTab />}
      {tab === "statistics" && <CompareStatsTab tab="statistics" />}
      {tab === "hotspots" && <CompareStatsTab tab="hotspots" />}
      {tab === "summary" && <CompareSummaryTab />}
    </div>
  );
}

/** Left-edge drag + keyboard handle for the desktop results panel. */
function PanelResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (value: number) => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    startRef.current = { x: event.clientX, width };
    const onMove = (moveEvent: PointerEvent): void => {
      const start = startRef.current;
      if (!start) return;
      onResize(start.width - (moveEvent.clientX - start.x));
    };
    const onUp = (): void => {
      startRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResize(width + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onResize(width - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      onResize(PANEL_WIDTH_MAX);
    } else if (event.key === "End") {
      event.preventDefault();
      onResize(PANEL_WIDTH_MIN);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize change detection panel"
      tabIndex={0}
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-ew-resize focus:outline-none"
      title="Drag to resize (← / → also works)"
    >
      <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-border" />
    </div>
  );
}

function SwipeHelp() {
  const dateA = useCompareStore((s) => s.dateA);
  const dateB = useCompareStore((s) => s.dateB);
  const divider = useCompareStore((s) => s.divider);
  const setDivider = useCompareStore((s) => s.setDivider);
  return (
    <div className="flex flex-col gap-2 text-xs text-text">
      <p className="text-muted">
        Date A imagery is on the left of the divider, date B on the right — drag the handle on the
        map (or use arrow keys) to sweep between the two dates.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="mono-nums flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-border bg-accent" aria-hidden />A ·{" "}
          {dateA ? formatShortDate(dateA) : "—"}
        </span>
        <span className="mono-nums flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-border bg-surface-2" aria-hidden />B
          · {dateB ? formatShortDate(dateB) : "—"}
        </span>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-muted">
        Divider
        <Slider
          className="min-w-0 flex-1"
          aria-label="Comparison divider position"
          min={0}
          max={100}
          step={1}
          value={Math.round(divider)}
          onChange={(event) => setDivider(Number(event.target.value))}
        />
        <span className="mono-nums">{Math.round(divider)}%</span>
      </label>
    </div>
  );
}

function ChangeMapTab() {
  const result = useCompareStore((s) => s.result);
  const overlayOpacity = useCompareStore((s) => s.overlayOpacity);
  const setOverlayOpacity = useCompareStore((s) => s.setOverlayOpacity);
  const classVisible = useCompareStore((s) => s.classVisible);
  const toggleClass = useCompareStore((s) => s.toggleClass);
  const boostVisibility = useCompareStore((s) => s.boostVisibility);
  const setBoostVisibility = useCompareStore((s) => s.setBoostVisibility);
  const [exporting, setExporting] = useState<"png" | "geotiff" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  if (!result) return null;
  const stats = result.stats;
  const { metadata } = stats;
  const lowValid = stats.validPct < 70;
  const hasChangeBbox = Boolean(stats.changeBbox);

  const doExport = async (format: "png" | "geotiff"): Promise<void> => {
    setExporting(format);
    setExportError(null);
    try {
      await downloadOverlayFile(result.overlayUrl, format, { dateA: metadata.dateA, dateB: metadata.dateB });
    } catch (error) {
      setExportError(error instanceof Error && error.message ? error.message : "Export failed.");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* ---------------------------------------------------- legend */}
      <ul className="flex flex-col">
        {LEGEND_ORDER.map((code) => {
          const def = CLASS_DEFS.find((candidate) => candidate.code === code);
          if (!def) return null;
          const visible = classVisible[def.code] !== false;
          const cls = stats.classes.find((candidate) => candidate.code === def.code);
          const area = cls ? cls.areaHa.toLocaleString("en", { maximumFractionDigits: 1 }) : "—";
          const pct = cls ? `${cls.pctOfValid.toFixed(1)}%` : "—";
          return (
            <li key={def.code}>
              <button
                type="button"
                aria-pressed={visible}
                onClick={() => toggleClass(def.code)}
                title={visible ? `Hide ${def.label}` : `Show ${def.label}`}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded px-1.5 text-left text-xs transition-colors duration-150 hover:bg-surface-2",
                  visible ? "text-text" : "text-muted opacity-60",
                )}
              >
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border"
                  style={{ background: visible ? rgb(def.color) : "transparent" }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{def.label}</span>
                <span className="mono-nums ml-auto shrink-0 whitespace-nowrap text-[10px] text-muted">
                  {pct} · {area} ha
                </span>
              </button>
            </li>
          );
        })}
        <li>
          <div className="flex h-9 items-center gap-2.5 px-1.5 text-xs text-muted">
            <span
              className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border"
              style={CHECKERBOARD}
              aria-hidden
            />
            <span className="min-w-0 flex-1">No change</span>
            <span className="shrink-0 text-[10px]">always transparent</span>
          </div>
        </li>
      </ul>

      {/* ------------------------------------------------ display settings */}
      <section className="flex flex-col gap-2">
        <p className="section-label">Display</p>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <span className="shrink-0">Overlay opacity</span>
          <Slider
            className="min-w-0 flex-1"
            aria-label="Change overlay opacity"
            min={0}
            max={1}
            step={0.05}
            value={overlayOpacity}
            onChange={(event) => setOverlayOpacity(Number(event.target.value))}
          />
          <span className="mono-nums w-9 shrink-0 text-right text-text">
            {Math.round(overlayOpacity * 100)}%
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={boostVisibility}
            onClick={() => setBoostVisibility(!boostVisibility)}
            className={cn(
              "flex w-full items-center gap-2 rounded border border-border bg-surface-2 px-2 py-1.5 text-left text-xs transition-colors duration-150",
              boostVisibility ? "text-text" : "text-muted",
            )}
            title="Display only: dilates small change patches and adds a contrast outline."
          >
            <span
              className={cn(
                "inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition-colors duration-150",
                boostVisibility ? "border-accent bg-accent-soft" : "border-border bg-surface",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 rounded-full transition-transform duration-150",
                  boostVisibility ? "translate-x-4 bg-accent" : "translate-x-0 bg-muted",
                )}
              />
            </span>
            <span className="min-w-0 flex-1">Boost visibility</span>
          </button>
          <p className="text-[10px] leading-snug text-muted">
            Enlarges small patches on the map. Display only; statistics are unchanged.
          </p>
        </div>
      </section>

      <Button
        size="sm"
        variant="secondary"
        className="w-full"
        disabled={!hasChangeBbox}
        title={
          hasChangeBbox
            ? "Frames the union of every detected change pixel."
            : "No detected change to zoom to."
        }
        onClick={() => focusChangeBbox()}
      >
        <Crosshair size={13} />
        Zoom to changes
      </Button>

      {lowValid && (
        <p className="text-[11px] text-warning">
          Only {stats.validPct.toFixed(0)}% valid data — some classes may be undercounted.
        </p>
      )}
      {stats.negligible && (
        <p className="text-[11px] text-muted">
          No significant change detected for this pair at the current sensitivity.
        </p>
      )}

      {/* ---------------------------------------------------- exports */}
      <section className="flex flex-col gap-2">
        <p className="section-label">Export</p>
        <Button size="sm" className="w-full" disabled={exporting !== null} onClick={() => void doExport("png")}>
          <Download size={13} />
          {exporting === "png" ? "Preparing…" : "Change map PNG"}
        </Button>
        <Button size="sm" className="w-full" disabled={exporting !== null} onClick={() => void doExport("geotiff")}>
          <Download size={13} />
          {exporting === "geotiff" ? "Preparing…" : "GeoTIFF"}
        </Button>
        <p className="text-[10px] leading-relaxed text-muted">
          GeoTIFF is uint8 with nodata 255 outside the polygon — opens directly in QGIS.
        </p>
        {exportError && <p className="text-[11px] text-danger">{exportError}</p>}
      </section>
    </div>
  );
}
