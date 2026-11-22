"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { MoveHorizontal } from "lucide-react";
import { getMainMap } from "@/lib/compare/bridge";
import { swipeClipPath } from "@/lib/compare/swipe";
import { POSITRON_STYLE_URL } from "@/lib/map/constants";
import { buildTileUrl } from "@/lib/map/tiles";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { formatShortDate } from "@/components/compare/CompareBar";

/**
 * Swipe overlay for the high-resolution (Bhoonidhi) layer: one clean
 * secondary maplibre instance carrying raw Sentinel-2 tiles for the picked
 * date, clipped to the LEFT of the divider; the right half is the main map
 * showing the high-resolution scene. The main map drives the camera
 * (one-way sync) and stays interactive — pointer events pass through the
 * wrapper so pan/zoom/selection keep working, same contract as the compare
 * swipe. Hidden while the compare Swipe tab owns the viewport.
 */
export default function VhrSwipeOverlay() {
  const vhrVisible = useAppStore((s) => s.vhrVisible);
  const vhrSwipe = useAppStore((s) => s.vhrSwipe);
  const vhrSceneId = useAppStore((s) => s.vhrSceneId);
  const vhrScenes = useAppStore((s) => s.vhrScenes);
  const vhrSwipeDate = useAppStore((s) => s.vhrSwipeDate);
  const divider = useAppStore((s) => s.vhrDivider);
  const setDivider = useAppStore((s) => s.setVhrDivider);
  const compareSwipeActive = useCompareStore(
    (s) => s.tab === "swipe" && s.result !== null,
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stripBottom = useStripBottom();

  const scene = vhrSceneId ? vhrScenes.find((candidate) => candidate.id === vhrSceneId) : null;
  const selection = useAppStore(selectActiveSelection);
  // S2 tiles need an area polygon (same constraint as the compare swipe);
  // without one the overlay stays off and the card shows the hint instead.
  const active = Boolean(vhrVisible && vhrSwipe && scene && vhrSwipeDate && selection) && !compareSwipeActive;

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    const moveTo = (clientX: number): void => {
      setDivider(((clientX - rect.left) / Math.max(1, rect.width)) * 100);
    };
    moveTo(event.clientX);
    const onMove = (moveEvent: PointerEvent): void => moveTo(moveEvent.clientX);
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onDividerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      setDivider(divider - step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      setDivider(divider + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      setDivider(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setDivider(100);
    }
  };

  const s2Year = vhrSwipeDate ? vhrSwipeDate.slice(0, 4) : "";
  const vhrLabel = scene ? formatShortDate(scene.acquiredAt) : "";

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[15]">
      {active && scene && vhrSwipeDate && (
        <>
          <div
            className="absolute inset-0 overflow-hidden bg-[#F8F8F8]"
            style={{ clipPath: swipeClipPath(divider, "left") }}
            aria-hidden
          >
            <S2SwipeMap date={vhrSwipeDate} />
          </div>

          <span
            className="mono-nums absolute top-3 -translate-x-full rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] text-text shadow-float"
            style={{ left: `${divider}%`, paddingRight: "0.5rem" }}
          >
            {`S2 · ${formatShortDate(vhrSwipeDate)}`}
          </span>
          <span
            className="mono-nums absolute top-3 rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] text-text shadow-float"
            style={{ left: `${divider}%`, paddingLeft: "0.5rem" }}
          >
            {`High-res · ${vhrLabel}`}
          </span>
          <div
            role="slider"
            tabIndex={0}
            aria-label="High-resolution swipe divider between Sentinel-2 and Bhoonidhi imagery"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(divider)}
            aria-valuetext={`${Math.round(divider)}% — Sentinel-2 on the left, high-resolution on the right`}
            onPointerDown={startDrag}
            onKeyDown={onDividerKeyDown}
            className="absolute bottom-0 top-0 -ml-3.5 w-7 cursor-ew-resize pointer-events-auto focus:outline-none"
            style={{ left: `${divider}%` }}
          >
            <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent shadow-float" />
            <span className="absolute left-1/2 top-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-surface text-text shadow-float max-lg:h-11 max-lg:w-11">
              <MoveHorizontal size={15} aria-hidden />
            </span>
          </div>
          <span
            className="absolute left-3 rounded bg-surface/90 px-1.5 py-0.5 text-[11px] leading-tight text-muted shadow-float"
            style={{ bottom: stripBottom }}
          >
            {`Contains modified Copernicus Sentinel data ${s2Year || "—"} · Source: NRSC / ISRO, via Bhoonidhi`}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Bottom offset for the attribution chip: desktop follows the docked scene
 * strip; phone/tablet clear the bottom tab bar and whichever sheet is open
 * (same maths as the compare swipe chips).
 */
function useStripBottom(): number | string {
  const resultsOpen = useAppStore((s) => s.resultsOpen);
  const searching = useAppStore((s) => s.searching);
  const hasSearched = useAppStore((s) => s.hasSearched);
  const stripHeightPx = useAppStore((s) => s.stripHeightPx);
  if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) {
    return "calc(var(--tabbar-h, 0px) + var(--sheet-h, 0px) + 12px)";
  }
  return resultsOpen && (searching || hasSearched) ? stripHeightPx + 12 : 12;
}

/**
 * The left half: a non-interactive Positron map carrying a single raw
 * Sentinel-2 raster layer (false colour, matching the high-resolution
 * rendering). Camera follows the main map; tiles are recreated when the
 * date or the selected area changes.
 */
function S2SwipeMap({ date }: { date: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const lastTileUrlRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const selectionId = useAppStore((s) => {
    const selection = selectActiveSelection(s);
    return selection ? `${selection.level}:${selection.id}` : "";
  });

  // ------------------------------------------------ map lifecycle (once per mount)
  useEffect(() => {
    let disposed = false;
    let detachSync: (() => void) | null = null;

    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (disposed || !hostRef.current) return;
      const main = getMainMap();
      const instance = new maplibregl.Map({
        container: hostRef.current,
        style: POSITRON_STYLE_URL,
        center: main ? main.getCenter() : [73.8, 26.5],
        zoom: main ? main.getZoom() : 5,
        bearing: main ? main.getBearing() : 0,
        pitch: main ? main.getPitch() : 0,
        attributionControl: false,
        interactive: false,
      });
      mapRef.current = instance;
      instance.on("load", () => {
        if (!disposed) setReady(true);
      });

      const syncFromMain = (): void => {
        const source = getMainMap();
        if (!source || !mapRef.current) return;
        mapRef.current.jumpTo({
          center: source.getCenter(),
          zoom: source.getZoom(),
          bearing: source.getBearing(),
          pitch: source.getPitch(),
        });
      };
      main?.on("move", syncFromMain);
      detachSync = () => main?.off("move", syncFromMain);
    })();

    return () => {
      disposed = true;
      detachSync?.();
      mapRef.current?.remove();
      mapRef.current = null;
      lastTileUrlRef.current = null;
      setReady(false);
    };
  }, []);

  // ------------------------------------------------ Sentinel-2 tiles
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const sourceId = "vhr-swipe-s2-tiles";
    const layerId = `${sourceId}-layer`;
    const selection = selectActiveSelection(useAppStore.getState());
    const removeTiles = (): void => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      lastTileUrlRef.current = null;
    };
    if (!selection) {
      removeTiles();
      return;
    }
    const url = buildTileUrl({
      date,
      areaId: selection.id,
      level: selection.level,
      composite: "false-color",
    });
    if (lastTileUrlRef.current === url) return;
    removeTiles();
    map.addSource(sourceId, {
      type: "raster",
      tiles: [url],
      tileSize: 512,
      minzoom: 7,
      maxzoom: 15,
      attribution: `Contains modified Copernicus Sentinel data ${date.slice(0, 4)}`,
    });
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": 1, "raster-fade-duration": 200 },
    });
    lastTileUrlRef.current = url;
  }, [ready, date, selectionId]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
