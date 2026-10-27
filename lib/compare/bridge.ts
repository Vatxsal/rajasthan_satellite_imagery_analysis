import type { ImageSource, Map as MapLibreMap, RasterTileSource } from "maplibre-gl";
import { bboxToBounds } from "@/lib/map/geojson";
import { buildTileUrlTemplate } from "@/lib/map/tiles";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";

/**
 * Compare-mode map bridge: module state + a registry for the single main map
 * instance (MapCanvas registers it), so compare layers can be driven from the
 * compare store without prop-drilling through MapCanvas.
 *
 * Layers added on the main map (anchor: just below the selection fill so the
 * AOI outline and shimmer stay on top):
 *  - "compare-scene-a"  raster tiles of date A  (Swipe tab only)
 *  - "compare-overlay"  classified change PNG   (every tab except Swipe)
 * The date-B tiles live on the secondary swipe map (CompareMapController).
 */

const SRC = {
  sceneA: "compare-scene-a",
  overlay: "compare-overlay",
} as const;

const LAYER = {
  sceneA: "compare-scene-a-layer",
  overlay: "compare-overlay-layer",
} as const;

/** MapCanvas anchors the selection fill just below the shimmer/outline pair. */
const ANCHOR_BELOW = "selection-fill";

type CompareCoords = [[number, number], [number, number], [number, number], [number, number]];

let mainMap: MapLibreMap | null = null;
/** Recoloured overlay image (blob URL) — null → serve the original PNG. */
let displayOverlayUrl: string | null = null;
/** URL + bbox currently applied to the image source (avoids refetch churn). */
let appliedOverlayUrl: string | null = null;
let appliedOverlayBbox: string | null = null;
/** Result key the display URL belongs to — reset when a new run lands. */
let displayKey: string | null = null;
/** Tiles currently loaded on the date-A source (skip redundant setTiles). */
let appliedSceneAUrl: string | null = null;

/** maplibre image-source coordinates are 4 corner pairs, NW-first. */
function imageCoords(bbox: [number, number, number, number]): CompareCoords {
  const [west, south, east, north] = bbox;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

function layerAnchor(map: MapLibreMap): string | undefined {
  if (map.getLayer(ANCHOR_BELOW)) return ANCHOR_BELOW;
  return (map.getStyle().layers ?? []).find((layer) => layer.type === "symbol")?.id;
}

function sceneTileUrl(date: string | null): string | null {
  if (!date) return null;
  const app = useAppStore.getState();
  const selection = selectActiveSelection(app);
  if (!selection) return null;
  const scene = app.scenes.find((candidate) => candidate.date === date);
  if (!scene) return null;
  return buildTileUrlTemplate({
    scene,
    areaId: selection.id,
    level: selection.level,
    composite: scene.composite,
  });
}

function removeSourceLayer(map: MapLibreMap, sourceId: string, layerId: string): void {
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/** Date-A tiles: only while the Swipe tab is showing a completed result. */
function syncSceneA(map: MapLibreMap): void {
  const state = useCompareStore.getState();
  const result = state.result;
  const wanted = result && state.tab === "swipe" ? sceneTileUrl(state.dateA) : null;
  if (!wanted || !result) {
    removeSourceLayer(map, SRC.sceneA, LAYER.sceneA);
    appliedSceneAUrl = null;
    return;
  }

  const existing = map.getSource(SRC.sceneA) as RasterTileSource | undefined;
  if (existing) {
    if (typeof existing.setTiles === "function" && appliedSceneAUrl !== wanted) {
      existing.setTiles([wanted]);
    }
    appliedSceneAUrl = wanted;
    if (map.getLayer(LAYER.sceneA)) map.setLayoutProperty(LAYER.sceneA, "visibility", "visible");
    return;
  }

  const year = state.dateA?.slice(0, 4) ?? result.stats.metadata.dateA.slice(0, 4);
  map.addSource(SRC.sceneA, {
    type: "raster",
    tiles: [wanted],
    tileSize: 512,
    minzoom: 7,
    maxzoom: 14,
    attribution: `Contains modified Copernicus Sentinel data ${year}`,
  });
  appliedSceneAUrl = wanted;
  map.addLayer(
    {
      id: LAYER.sceneA,
      type: "raster",
      source: SRC.sceneA,
      paint: { "raster-opacity": 1, "raster-fade-duration": 200 },
    },
    layerAnchor(map),
  );
}

/** Classified overlay image source — visibility follows the active tab. */
function syncOverlay(map: MapLibreMap): void {
  const state = useCompareStore.getState();
  const result = state.result;
  if (!result) {
    removeSourceLayer(map, SRC.overlay, LAYER.overlay);
    appliedOverlayUrl = null;
    appliedOverlayBbox = null;
    return;
  }

  const wantedUrl = displayOverlayUrl ?? result.overlayUrl;
  const bboxKey = result.bbox.join(",");
  const existing = map.getSource(SRC.overlay) as ImageSource | undefined;

  if (!existing) {
    map.addSource(SRC.overlay, { type: "image", url: wantedUrl, coordinates: imageCoords(result.bbox) });
    appliedOverlayUrl = wantedUrl;
    appliedOverlayBbox = bboxKey;
    map.addLayer(
      {
        id: LAYER.overlay,
        type: "raster",
        source: SRC.overlay,
        layout: { visibility: state.tab !== "swipe" ? "visible" : "none" },
        paint: { "raster-opacity": state.overlayOpacity, "raster-fade-duration": 0 },
      },
      layerAnchor(map),
    );
    return;
  }

  if (appliedOverlayUrl !== wantedUrl || appliedOverlayBbox !== bboxKey) {
    existing.updateImage({ url: wantedUrl, coordinates: imageCoords(result.bbox) });
    appliedOverlayUrl = wantedUrl;
    appliedOverlayBbox = bboxKey;
  }
  if (map.getLayer(LAYER.overlay)) {
    map.setLayoutProperty(LAYER.overlay, "visibility", state.tab !== "swipe" ? "visible" : "none");
    map.setPaintProperty(LAYER.overlay, "raster-opacity", state.overlayOpacity);
  }
}

function syncCompareMap(map: MapLibreMap): void {
  try {
    if (!map.isStyleLoaded()) return; // style.load → addAppLayers → addCompareLayers
    syncSceneA(map);
    syncOverlay(map);
  } catch {
    // Map disposed mid-sync — next registration rebuilds from store state.
  }
}

/**
 * Entry point from MapCanvas.addAppLayers(): rebuilds both compare sources
 * for the freshly loaded style from the current store state. `style.load`
 * can fire before the style reports fully loaded — in that case the sync is
 * deferred to the next `idle`, which is guaranteed to follow.
 */
export function addCompareLayers(map: MapLibreMap): void {
  if (map.isStyleLoaded()) {
    syncCompareMap(map);
    return;
  }
  map.once("idle", () => {
    try {
      syncCompareMap(map);
    } catch {
      // Map disposed before the style settled.
    }
  });
}

export function registerMainMap(map: MapLibreMap): void {
  mainMap = map;
  syncCompareMap(map);
}

export function unregisterMainMap(map: MapLibreMap): void {
  if (mainMap === map) mainMap = null;
}

export function getMainMap(): MapLibreMap | null {
  return mainMap;
}

/**
 * Swaps the overlay image (recoloured blob URL after class toggles, or the
 * original server PNG). Module state keeps the URL across style reloads.
 */
export function setOverlayImage(url: string | null, key: string): void {
  if (displayKey !== key) {
    displayKey = key;
    // New result → previous blob (if any) is garbage now.
    if (displayOverlayUrl && displayOverlayUrl.startsWith("blob:")) {
      URL.revokeObjectURL(displayOverlayUrl);
    }
  }
  displayOverlayUrl = url;
  const map = mainMap;
  const result = useCompareStore.getState().result;
  if (!map || !result || !map.getSource(SRC.overlay)) return;
  const source = map.getSource(SRC.overlay) as ImageSource | undefined;
  if (!source) return;
  const next = url ?? result.overlayUrl;
  if (appliedOverlayUrl === next) return;
  try {
    source.updateImage({ url: next, coordinates: imageCoords(result.bbox) });
    appliedOverlayUrl = next;
  } catch {
    // Style swapping underneath us — style.load rebuild restores the state.
  }
}

/** Hotspot click → frame its patch bbox on the main map. */
export function focusHotspot(bbox: [number, number, number, number]): void {
  mainMap?.fitBounds(bboxToBounds(bbox), { padding: 80, duration: 500, maxZoom: 14 });
}

// Drive the registered map from store changes (result, tab, opacity, …).
useCompareStore.subscribe(() => {
  const state = useCompareStore.getState();
  if (state.result?.key !== displayKey && state.result) {
    // A newer result landed: drop the previous display URL before syncing.
    displayKey = state.result.key;
    if (displayOverlayUrl && displayOverlayUrl.startsWith("blob:")) {
      URL.revokeObjectURL(displayOverlayUrl);
    }
    displayOverlayUrl = null;
    appliedOverlayUrl = null;
    appliedOverlayBbox = null;
  }
  if (!state.result) {
    displayKey = null;
    if (displayOverlayUrl && displayOverlayUrl.startsWith("blob:")) {
      URL.revokeObjectURL(displayOverlayUrl);
    }
    displayOverlayUrl = null;
  }
  if (mainMap) syncCompareMap(mainMap);
});
