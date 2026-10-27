"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { MoveHorizontal } from "lucide-react";
import { getMainMap, setOverlayImage } from "@/lib/compare/bridge";
import { buildOverlayBlobUrl, loadOverlayImageData, needsRecolor } from "@/lib/compare/recolor";
import { POSITRON_STYLE_URL } from "@/lib/map/constants";
import { buildTileUrlTemplate } from "@/lib/map/tiles";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { useTheme } from "@/store/useTheme";
import { formatShortDate } from "./CompareBar";

/**
 * Map-layer side of compare mode: keeps the classified overlay recoloured,
 * and renders the swipe view — a secondary non-interactive maplibre instance
 * showing date B, clipped to the right of the divider (date A tiles are on
 * the main map via the bridge). Camera sync is one-way, main → secondary.
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

  const rootRef = useRef<HTMLDivElement | null>(null);
  const blobRef = useRef<string | null>(null);

  const swipeActive = Boolean(result) && tab === "swipe";

  // ------------------------------------------------ overlay recolour
  useEffect(() => {
    if (!result) return;

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
  }, [result, classVisible, boost, theme]);

  useEffect(
    () => () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    },
    [],
  );

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
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-20">
      {swipeActive && (
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 0 0 ${divider}%)` }}
          aria-hidden
        >
          <SwipeMap />
        </div>
      )}

      {swipeActive && (
        <>
          <span
            className="mono-nums absolute top-3 -translate-x-full rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] text-text shadow-float"
            style={{ left: `${divider}%`, paddingRight: "0.5rem" }}
          >
            A · {dateA ? formatShortDate(dateA) : ""}
          </span>
          <span
            className="mono-nums absolute top-3 rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] text-text shadow-float"
            style={{ left: `${divider}%`, paddingLeft: "0.5rem" }}
          >
            B · {dateB ? formatShortDate(dateB) : ""}
          </span>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Comparison divider between date A and date B"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(divider)}
            aria-valuetext={`${Math.round(divider)}% — A on the left, B on the right`}
            onPointerDown={startDrag}
            onKeyDown={onDividerKeyDown}
            className="absolute bottom-0 top-0 -ml-3.5 w-7 cursor-ew-resize pointer-events-auto focus:outline-none"
            style={{ left: `${divider}%` }}
          >
            <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent shadow-float" />
            <span className="absolute left-1/2 top-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-surface text-text shadow-float">
              <MoveHorizontal size={15} aria-hidden />
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Secondary map: date B tiles over the plain basemap, camera follows main. */
function SwipeMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dateB = useCompareStore((s) => s.dateB);

  useEffect(() => {
    let disposed = false;
    let map: MapLibreMap | null = null;
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
      map = instance;

      const addSceneBTiles = (): void => {
        if (disposed || !map) return;
        const compare = useCompareStore.getState();
        const app = useAppStore.getState();
        const selection = selectActiveSelection(app);
        const scene = compare.dateB ? app.scenes.find((candidate) => candidate.date === compare.dateB) : null;
        if (!selection || !scene || map.getSource("compare-scene-b")) return;
        const url = buildTileUrlTemplate({
          scene,
          areaId: selection.id,
          level: selection.level,
          composite: scene.composite,
        });
        map.addSource("compare-scene-b", {
          type: "raster",
          tiles: [url],
          tileSize: 512,
          minzoom: 7,
          maxzoom: 14,
          attribution: `Contains modified Copernicus Sentinel data ${scene.date.slice(0, 4)}`,
        });
        map.addLayer({
          id: "compare-scene-b-layer",
          type: "raster",
          source: "compare-scene-b",
          paint: { "raster-opacity": 1, "raster-fade-duration": 200 },
        });
      };
      instance.on("load", addSceneBTiles);

      const mainMap = getMainMap();
      const syncFromMain = (): void => {
        const source = getMainMap();
        if (!source || !map) return;
        map.jumpTo({
          center: source.getCenter(),
          zoom: source.getZoom(),
          bearing: source.getBearing(),
          pitch: source.getPitch(),
        });
      };
      mainMap?.on("move", syncFromMain);
      detachSync = () => mainMap?.off("move", syncFromMain);
    })();

    return () => {
      disposed = true;
      detachSync?.();
      map?.remove();
      map = null;
    };
  }, [dateB]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
