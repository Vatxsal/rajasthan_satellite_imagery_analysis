"use client";

import { useRef, useState } from "react";
import { Crosshair, Download, Loader2, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import Slider from "@/components/ui/Slider";
import { cn } from "@/components/ui/cn";
import { downloadOverlayFile } from "@/lib/compare/export";
import { focusChangeBbox } from "@/lib/compare/bridge";
import { CLASS_DEFS, CLASS } from "@/lib/analysis/config";
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

const TAB_OPTIONS: Array<{ value: CompareTab; label: string }> = [
  { value: "swipe", label: "Swipe" },
  { value: "change-map", label: "Change map" },
  { value: "statistics", label: "Statistics" },
  { value: "hotspots", label: "Hotspots" },
  { value: "summary", label: "Summary" },
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
 * capped at 45vh above the scene strip.
 */
export default function CompareDrawer() {
  const open = useCompareStore((s) => s.drawerOpen);
  const result = useCompareStore((s) => s.result);
  const tab = useCompareStore((s) => s.tab);
  const setTab = useCompareStore((s) => s.setTab);
  const setDrawerOpen = useCompareStore((s) => s.setDrawerOpen);
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
        className="relative z-40 flex shrink-0 flex-col border-l border-border bg-surface"
        style={{ width: panelWidth }}
      >
        <PanelResizeHandle width={panelWidth} onResize={setPanelWidth} />
        <header className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-text">
                Change detection · {metadata.areaName}
              </p>
              <p className="mono-nums truncate text-[11px] text-muted">
                {formatShortDate(metadata.dateA)} → {formatShortDate(metadata.dateB)} ·{" "}
                {metadata.gapDays}d gap (earlier → later)
              </p>
            </div>
            <button
              type="button"
              aria-label="Close change detection results"
              onClick={() => setDrawerOpen(false)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
            >
              <X size={14} />
            </button>
          </div>
          <Segmented
            ariaLabel="Change detection views"
            options={TAB_OPTIONS}
            value={tab}
            onChange={setTab}
          />
        </header>
        <DrawerBody tab={tab} running={running} />
      </aside>
    );
  }

  const stripActive = searching || hasSearched;
  const bottom = stripOpen && stripActive ? stripHeightPx : 0;

  return (
    <section
      aria-label="Change detection results"
      className="fixed inset-x-0 bottom-0 z-40 flex max-h-[45vh] flex-col border-t border-border bg-surface shadow-float"
      style={{ bottom }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-text">
            Change detection · {metadata.areaName}
          </p>
          <p className="mono-nums truncate text-[11px] text-muted">
            {formatShortDate(metadata.dateA)} → {formatShortDate(metadata.dateB)} ·{" "}
            {metadata.gapDays}d gap (earlier → later)
          </p>
        </div>
        <Segmented
          className="ml-auto min-w-[17rem] flex-1 sm:flex-none"
          ariaLabel="Change detection views"
          options={TAB_OPTIONS}
          value={tab}
          onChange={setTab}
        />
        <button
          type="button"
          aria-label="Close change detection results"
          onClick={() => setDrawerOpen(false)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          <X size={14} />
        </button>
      </header>
      <DrawerBody tab={tab} running={running} />
    </section>
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
          className="max-w-[16rem]"
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
    <div className="flex flex-col gap-3 lg:flex-row">
      {/* legend + layer controls */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-xs text-muted">
          Classified change over {metadata.areaName} — toggle a class to hide it on the map.
        </p>
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {CLASS_DEFS.map((def) => {
            if (def.code === CLASS.noChange) {
              return (
                <li key={def.code} className="flex items-center gap-2 rounded border border-transparent px-1.5 py-1 text-xs text-muted">
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm border border-border"
                    style={CHECKERBOARD}
                    aria-hidden
                  />
                  {def.label}
                  <span className="ml-auto text-[10px]">No change · transparent</span>
                </li>
              );
            }
            const visible = classVisible[def.code] !== false;
            const cls = stats.classes.find((candidate) => candidate.code === def.code);
            return (
              <li key={def.code}>
                <button
                  type="button"
                  aria-pressed={visible}
                  onClick={() => toggleClass(def.code)}
                  title={visible ? `Hide ${def.label}` : `Show ${def.label}`}
                  className={cn(
                    "flex w-full items-center gap-2 rounded border px-1.5 py-1 text-left text-xs transition-colors duration-150",
                    visible
                      ? "border-border bg-surface-2 text-text"
                      : "border-transparent bg-surface-2 text-muted opacity-60",
                  )}
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm border border-border"
                    style={{ background: visible ? rgb(def.color) : "transparent" }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{def.label}</span>
                  {cls && <span className="mono-nums shrink-0 text-[10px] text-muted">{cls.pctOfValid.toFixed(1)}%</span>}
                </button>
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          role="switch"
          aria-checked={boostVisibility}
          onClick={() => setBoostVisibility(!boostVisibility)}
          className={cn(
            "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors duration-150",
            boostVisibility
              ? "border-border bg-surface-2 text-text"
              : "border-border bg-surface-2 text-muted",
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
          <span className="min-w-0 flex-1">
            Boost visibility
            <span className="block text-[10px] text-muted">
              Dilates small patches + contrast outline · display only
            </span>
          </span>
        </button>

        <label className="flex max-w-sm items-center gap-2 text-[11px] text-muted">
          Overlay opacity
          <Slider
            className="flex-1"
            aria-label="Change overlay opacity"
            min={0}
            max={1}
            step={0.05}
            value={overlayOpacity}
            onChange={(event) => setOverlayOpacity(Number(event.target.value))}
          />
          <span className="mono-nums w-8 text-right text-text">{Math.round(overlayOpacity * 100)}%</span>
        </label>

        <Button
          size="sm"
          className="w-fit"
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
      </div>

      {/* exports */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-2 lg:w-56 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
        <p className="text-xs font-medium text-text">Export</p>
        <Button size="sm" disabled={exporting !== null} onClick={() => void doExport("png")}>
          <Download size={13} />
          {exporting === "png" ? "Preparing…" : "Change map (PNG)"}
        </Button>
        <Button size="sm" disabled={exporting !== null} onClick={() => void doExport("geotiff")}>
          <Download size={13} />
          {exporting === "geotiff" ? "Preparing…" : "GeoTIFF (GIS)"}
        </Button>
        <p className="text-[10px] leading-relaxed text-muted">
          GeoTIFF is uint8 with nodata 255 outside the polygon — opens directly in QGIS.
        </p>
        {exportError && <p className="text-[11px] text-danger">{exportError}</p>}
      </div>
    </div>
  );
}
