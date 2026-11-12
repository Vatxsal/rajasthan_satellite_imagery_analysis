"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { MoveHorizontal } from "lucide-react";
import { getMainMap, setDebugMap, setOverlayImage, syncTabVisibility } from "@/lib/compare/bridge";
import { buildOverlayBlobUrl, loadOverlayImageData, needsRecolor } from "@/lib/compare/recolor";
import { swipeAttribution, swipeClipPath } from "@/lib/compare/swipe";
import { POSITRON_STYLE_URL, SATELLITE_BASEMAP } from "@/lib/map/constants";
import { buildTileUrl } from "@/lib/map/tiles";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { useTheme } from "@/store/useTheme";
import { formatShortDate } from "./CompareBar";
import SwipeDebugBadge from "./SwipeDebugBadge";

/**
 * Map-layer side of compare mode: keeps the classified overlay recoloured,
 * and renders the swipe view — two clean secondary maplibre instances with
 * no app layers, no overlay and no tint: the left half shows raw date-A
 * tiles, the right half date B tiles, each clipped at the divider over a
 * plain Positron basemap (imagery covers the labels inside the area,
 * transparent outside so the basemap shows through). The main map sits
 * covered underneath and only drives the camera (one-way sync); pointer
 * events pass through the wrappers so pan/zoom/selection keep working.
 * Root sits below the z-20 map controls (search, zoom, notices) so they
 * stay reachable during the sweep.
 */
export default function CompareMapController() {
  const result = useCompareStore((s) => s.result);
  const tab = useCompareStore((s) => s.tab);
  const divider = useCompareStore((s) => s.divider);
  const setDivider = useCompareStore((s) => s.setDivider);
  const classVisible = useCompareStore((s) => s.classVisible);
  const boost = useCompareStore((s) => s.boostVisibility);
  const theme = useTheme((s) => s.theme);
  const dateA = useCompareStore((s) => s.dateA);
  const dateB = useCompareStore((s) => s.dateB);
  const swipeMode = useCompareStore((s) => s.swipeMode);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const blobRef = useRef<string | null>(null);

  const swipeActive = Boolean(result) && tab === "swipe";
  const stripBottom = useStripBottom();

  // ------------------------------------------------ overlay recolour
  useEffect(() => {
    // Swipe shows raw imagery — the recoloured overlay is only for other tabs.
    if (!result || tab === "swipe") return;

    const apply = (url: string | null): void => {
      const previous = blobRef.current;
      blobRef.current = url;
      setOverlayImage(url, result.key);
      if (previous && previous !== url && previous.startsWith("blob:")) {
        // Delay: maplibre may still be decoding the swapped-out frame.
        window.setTimeout(() => URL.revokeObjectURL(previous), 10_000);
      }
    };

    if (!needsRecolor(classVisible, { boost })) {
      apply(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const base = await loadOverlayImageData(result.key, result.overlayUrl);
        const url = await buildOverlayBlobUrl(base, classVisible, { boost, theme });
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        apply(url);
      } catch {
        // Base PNG not loadable — the original overlay keeps showing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [result, tab, classVisible, boost, theme]);

  useEffect(
    () => () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    },
    [],
  );

  // Entering swipe hides the main-map compare layers immediately — the full
  // bridge sync may defer to idle while the style is settling.
  useEffect(() => {
    syncTabVisibility();
  }, [tab, result]);

  // ------------------------------------------------ divider drag + keys
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

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[15]">
      {swipeActive && (
        <>
          <div
            className="absolute inset-0 overflow-hidden bg-[#F8F8F8]"
            style={{ clipPath: swipeClipPath(divider, "left") }}
            aria-hidden
          >
            <SwipeMap slot="left" />
          </div>
          <div
            className="absolute inset-0 overflow-hidden bg-[#F8F8F8]"
            style={{ clipPath: swipeClipPath(divider, "right") }}
            aria-hidden
          >
            <SwipeMap slot="right" />
          </div>
        </>
      )}

      {swipeActive && (
        <>
          <span
            className="mono-nums absolute top-3 -translate-x-full rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] text-text shadow-float"
            style={{ left: `${divider}%`, paddingRight: "0.5rem" }}
          >
            {swipeMode === "basemap"
              ? `Sentinel-2 · ${dateA ? formatShortDate(dateA) : ""}`
              : `A · ${dateA ? formatShortDate(dateA) : ""}`}
          </span>
          <span
            className="mono-nums absolute top-3 rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] text-text shadow-float"
            style={{ left: `${divider}%`, paddingLeft: "0.5rem" }}
          >
            {swipeMode === "basemap" ? "Satellite basemap" : `B · ${dateB ? formatShortDate(dateB) : ""}`}
          </span>
          <div
            role="slider"
            tabIndex={0}
            aria-label={
              swipeMode === "basemap"
                ? "Comparison divider between Sentinel-2 imagery and the satellite basemap"
                : "Comparison divider between date A and date B"
            }
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(divider)}
            aria-valuetext={
              swipeMode === "basemap"
                ? `${Math.round(divider)}% — Sentinel-2 on the left, satellite basemap on the right`
                : `${Math.round(divider)}% — A on the left, B on the right`
            }
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
          {swipeMode === "basemap" && (
            <span
              className="absolute left-1/2 -translate-x-1/2 rounded bg-surface/90 px-1.5 py-0.5 text-[11px] leading-tight text-muted shadow-float"
              style={{ bottom: stripBottom }}
            >
              Basemap imagery is from a different date
            </span>
          )}
          <span
            className="absolute left-3 rounded bg-surface/90 px-1.5 py-0.5 text-[11px] leading-tight text-muted"
            style={{ bottom: stripBottom }}
          >
            {swipeAttribution({ dateA, dateB, mode: swipeMode })}
          </span>
          {process.env.NODE_ENV !== "production" && (
            <div className="absolute right-3" style={{ bottom: stripBottom }}>
              <SwipeDebugBadge />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Bottom offset for compare chips: desktop follows the docked scene strip;
 * phone/tablet clear the bottom tab bar and whichever sheet is open.
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

type SwipeSlot = "left" | "right";

/** Neutral AOI outline colours — readable on imagery and on Positron. */
const OUTLINE_COLORS = {
  light: { line: "rgb(75, 85, 99)", casing: "rgba(255, 255, 255, 0.85)" },
  dark: { line: "rgb(209, 213, 219)", casing: "rgba(24, 26, 32, 0.8)" },
} as const;

/**
 * One half of the swipe view: a non-interactive Positron map carrying a
 * single raw-imagery raster layer for its date (composite follows the store)
 * plus an optional neutral outline of the analysed area. In basemap mode the
 * right half shows the Esri satellite basemap instead of date B. Camera
 * follows the main map; tiles are recreated in place when the
 * date/composite/mode changes.
 */
function SwipeMap({ slot }: { slot: SwipeSlot }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const lastTileUrlRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const date = useCompareStore((s) => (slot === "left" ? s.dateA : s.dateB));
  const composite = useCompareStore((s) => s.swipeComposite);
  const swipeMode = useCompareStore((s) => s.swipeMode);
  const outline = useCompareStore((s) => s.swipeOutline);
  const theme = useTheme((s) => s.theme);

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
      setDebugMap(slot, instance);
      instance.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
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
      setDebugMap(slot, null);
      mapRef.current?.remove();
      mapRef.current = null;
      lastTileUrlRef.current = null;
      setReady(false);
    };
  }, [slot]);

  // ------------------------------------------------ raw imagery tiles
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const sourceId = `swipe-${slot}-tiles`;
    const layerId = `${sourceId}-layer`;
    const removeTiles = (): void => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      lastTileUrlRef.current = null;
    };

    // Right half can swap date B for the Esri satellite basemap (different
    // tile size/zooms → the source is recreated on every switch).
    const basemapActive = slot === "right" && swipeMode === "basemap";
    if (basemapActive) {
      const url = `basemap:${SATELLITE_BASEMAP.tiles[0]}`;
      if (lastTileUrlRef.current === url) return;
      removeTiles();
      map.addSource(sourceId, {
        type: "raster",
        tiles: [...SATELLITE_BASEMAP.tiles],
        tileSize: 256,
        maxzoom: SATELLITE_BASEMAP.maxzoom,
        attribution: SATELLITE_BASEMAP.attribution,
      });
      map.addLayer({
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: { "raster-opacity": 1, "raster-fade-duration": 200 },
      });
      lastTileUrlRef.current = url;
      return;
    }

    if (!date) {
      removeTiles();
      return;
    }
    const selection = selectActiveSelection(useAppStore.getState());
    if (!selection) return;
    const url = buildTileUrl({ date, areaId: selection.id, level: selection.level, composite });
    if (lastTileUrlRef.current === url) return;
    // Configs differ across switches (basemap ↔ Sentinel, tile size) — recreate.
    if (map.getSource(sourceId)) removeTiles();
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
  }, [ready, date, composite, slot, swipeMode]);

  // ------------------------------------------------ neutral AOI outline
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const sourceId = `swipe-${slot}-outline`;
    const casingId = `${sourceId}-casing`;
    const lineId = `${sourceId}-line`;
    const selection = selectActiveSelection(useAppStore.getState());
    if (selection) {
      const data: GeoJSON.Feature = {
        type: "Feature",
        properties: {},
        geometry: selection.geometry,
      };
      const source = map.getSource(sourceId) as GeoJSONSource | undefined;
      if (source) source.setData(data);
      else {
        map.addSource(sourceId, { type: "geojson", data });
        map.addLayer({
          id: casingId,
          type: "line",
          source: sourceId,
          paint: { "line-width": 3, "line-opacity": 0.85 },
        });
        map.addLayer({
          id: lineId,
          type: "line",
          source: sourceId,
          paint: { "line-width": 1.4 },
        });
      }
    }
    const colors = OUTLINE_COLORS[theme];
    const visible = outline ? "visible" : "none";
    if (map.getLayer(casingId)) {
      map.setLayoutProperty(casingId, "visibility", visible);
      map.setPaintProperty(casingId, "line-color", colors.casing);
    }
    if (map.getLayer(lineId)) {
      map.setLayoutProperty(lineId, "visibility", visible);
      map.setPaintProperty(lineId, "line-color", colors.line);
    }
  }, [ready, outline, theme, slot]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
