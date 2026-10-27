"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GeoJSONSource,
  ImageSource,
  LineLayerSpecification,
  Map as MapLibreMap,
  RasterTileSource,
} from "maplibre-gl";
import { union, featureCollection as turfFeatureCollection } from "@turf/turf";
import type { Scene } from "@/lib/data";
import { dataAdapter } from "@/lib/data";
import { useIsDesktop } from "@/lib/hooks/useMediaQuery";
import {
  HOME_VIEW,
  POSITRON_STYLE_URL,
  RAJASTHAN_BBOX,
  SATELLITE_BASEMAP,
  bboxToPolygon,
} from "@/lib/map/constants";
import { buildTileUrlTemplate } from "@/lib/map/tiles";
import { addCompareLayers, registerMainMap, unregisterMainMap } from "@/lib/compare/bridge";
import {
  EMPTY_FEATURE_COLLECTION,
  bboxToBounds,
  featureCollection,
  toFeature,
} from "@/lib/map/geojson";
import { BOUNDARY_LINE_THEMES, MAP_PALETTES, type BoundaryLineStyle } from "@/lib/map/palette";
import { createPlaceholderImageryUrl } from "@/lib/map/placeholderImagery";
import { selectActiveSelection, useActiveScene, useActiveSelection, useAppStore } from "@/store/useAppStore";
import { useTheme, type ThemeId } from "@/store/useTheme";
import AddressSearch from "./AddressSearch";
import BasemapSwitcher from "./BasemapSwitcher";
import CompositeLegendBar from "./CompositeLegend";
import CursorCoords from "./CursorCoords";
import LegendControl from "./LegendControl";
import MapControls from "./MapControls";

const SRC = {
  satellite: SATELLITE_BASEMAP.id,
  districts: "admin-districts",
  tehsils: "admin-tehsils",
  ilrs: "admin-ilrs",
  stateOutline: "admin-rajasthan",
  selection: "selection",
  activeScene: "active-scene",
  imagery: "imagery-preview",
  shimmer: "imagery-shimmer",
} as const;

const LAYER = {
  satellite: "basemap-satellite",
  districts: "districts-line",
  tehsils: "tehsils-line",
  ilrs: "ilrs-line",
  stateLine: "rajasthan-line",
  // Dark-mode contrast: MapLibre line layers have no halo paint, so each
  // boundary gets a wider "casing" line stacked directly underneath it.
  districtsCasing: "districts-casing",
  tehsilsCasing: "tehsils-casing",
  ilrsCasing: "ilrs-casing",
  stateCasing: "rajasthan-casing",
  selectionFill: "selection-fill",
  selectionLine: "selection-line",
  sceneLine: "active-scene-line",
  imagery: "imagery-layer",
  shimmer: "imagery-shimmer-fill",
} as const;

interface BaseLayerSnapshot {
  id: string;
  visibility: string;
}

interface AdminBoundaryData {
  districts: GeoJSON.FeatureCollection;
  tehsils: GeoJSON.FeatureCollection;
  ilrs: GeoJSON.FeatureCollection;
}

/**
 * Module-level runtime state for the single map instance. addAppLayers()
 * re-runs on every style.load, so everything it needs to rebuild the layer
 * stack lives here instead of in component refs.
 */
const mapRuntime = {
  baseLayers: [] as BaseLayerSnapshot[],
  /** Mock-mode placeholder image URL (created once, reused across styles). */
  placeholderUrl: null as string | null,
  adminData: null as AdminBoundaryData | null,
  adminLoad: null as Promise<AdminBoundaryData> | null,
  /** Union of all districts = Rajasthan state outline (All Rajasthan view). */
  outlineData: null as GeoJSON.Feature | null,
  outlineLoad: null as Promise<GeoJSON.Feature | null> | null,
  imageryTilesUrl: null as string | null,
  imagerySelectionKey: null as string | null,
  liveRequest: 0,
  shimmerTimer: null as number | null,
};

/**
 * Defensive layer insertion. MapLibre's `addLayer()` does NOT throw on an
 * invalid layer — it fires an `error` event and silently skips the layer, which
 * is how a bad paint property used to wipe out every boundary line. This wraps
 * the call, checks the style's `beforeId` anchor, verifies the layer actually
 * landed in the style afterwards and always logs a clear console.error.
 */
function addLayerSafe(
  map: MapLibreMap,
  layer: Parameters<MapLibreMap["addLayer"]>[0],
  beforeId?: string,
): boolean {
  const id = "id" in layer ? String(layer.id) : "<unknown>";
  try {
    let anchor = beforeId;
    if (beforeId && !map.getLayer(beforeId)) {
      // eslint-disable-next-line no-console
      console.error(
        `[map] beforeId "${beforeId}" is not in the loaded style — appending layer "${id}" to the end of the stack instead.`,
      );
      anchor = undefined;
    }
    map.addLayer(layer, anchor);
    if (!map.getLayer(id)) {
      // eslint-disable-next-line no-console
      console.error(
        `[map] layer "${id}" was rejected by the style validator — check its paint/layout properties against the MapLibre style spec.`,
      );
      return false;
    }
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[map] failed to add layer "${id}"`, error);
    return false;
  }
}

/**
 * The single place where every custom map source/layer is created: satellite
 * basemap, admin boundaries, selection, scene footprint, shimmer and imagery
 * (live raster tiles or the mock placeholder). Re-run on every `style.load`
 * because MapLibre wipes custom layers when a style is (re)loaded — it
 * restores visibility, selection, active scene and imagery opacity from the
 * store, and inserts everything below the basemap's label layers so names
 * stay readable.
 */
function addAppLayers(map: MapLibreMap): void {
  // Idempotent within one loaded style (both `style.load` and `load` fire).
  if (map.getSource(SRC.districts)) return;

  applyLatinLabels(map);

  // Capture base style layers (labels included) BEFORE adding our own — the
  // basemap toggle hides exactly these when satellite mode is active.
  const styleLayers = map.getStyle().layers ?? [];
  mapRuntime.baseLayers = styleLayers.map((layer) => ({
    id: layer.id,
    visibility:
      "visibility" in layer && typeof layer.layout?.visibility === "string"
        ? layer.layout.visibility
        : "visible",
  }));
  // Anchor: every custom layer is inserted directly below the first label layer.
  const firstLabelId = styleLayers.find((layer) => layer.type === "symbol")?.id;

  const state = useAppStore.getState();
  const theme = useTheme.getState().theme;
  const palette = MAP_PALETTES[theme];
  const lines = BOUNDARY_LINE_THEMES[theme];
  const selection = selectActiveSelection(state);
  const activeScene =
    state.scenes.find((candidate) => candidate.id === state.activeSceneId) ?? null;

  // ---------------------------------------------------------- satellite basemap
  map.addSource(SRC.satellite, {
    type: "raster",
    tiles: [...SATELLITE_BASEMAP.tiles],
    tileSize: 256,
    maxzoom: SATELLITE_BASEMAP.maxzoom,
    attribution: SATELLITE_BASEMAP.attribution,
  });
  map.addLayer(
    {
      id: LAYER.satellite,
      type: "raster",
      source: SRC.satellite,
      layout: { visibility: state.basemap === "satellite" ? "visible" : "none" },
      paint: { "raster-opacity": 1 },
    },
    firstLabelId,
  );

  // ---------------------------------------------------------- custom sources
  map.addSource(SRC.districts, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  map.addSource(SRC.tehsils, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  map.addSource(SRC.ilrs, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  map.addSource(SRC.stateOutline, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  map.addSource(SRC.activeScene, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  map.addSource(SRC.selection, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  map.addSource(SRC.shimmer, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });

  // ---------------------------------------------------------- boundary lines (theme aware)
  // MapLibre `line` layers have NO halo paint properties (`line-halo-*` only
  // exist on symbol layers as `text-halo-*`). Passing them makes the style
  // validator reject the whole layer, so the dark-theme halo is drawn as a
  // separate wider "casing" line stacked directly under its line instead.
  // Light theme keeps haloWidth 0 → casing width 0 → flat original look.
  const boundaryPair = (
    lineId: string,
    casingId: string,
    source: string,
    style: BoundaryLineStyle,
    visibility: "none" | "visible",
    paint: Record<string, number | number[]> = {},
  ): void => {
    addLayerSafe(
      map,
      {
        id: casingId,
        type: "line",
        source,
        layout: { visibility },
        paint: { "line-color": style.haloColor, "line-width": style.haloWidth, ...paint },
      } as LineLayerSpecification,
      firstLabelId,
    );
    addLayerSafe(
      map,
      {
        id: lineId,
        type: "line",
        source,
        layout: { visibility },
        paint: { "line-color": style.color, "line-width": style.width, ...paint },
      } as LineLayerSpecification,
      firstLabelId,
    );
  };

  // Subtle state-wide outline, only for the "All Rajasthan" view — drawn first
  // so districts, tehsils and the selection always sit above it.
  boundaryPair(
    LAYER.stateLine,
    LAYER.stateCasing,
    SRC.stateOutline,
    lines.state,
    selection ? "none" : "visible",
  );

  boundaryPair(
    LAYER.districts,
    LAYER.districtsCasing,
    SRC.districts,
    lines.districts,
    state.adminLayers.districts ? "visible" : "none",
  );
  boundaryPair(
    LAYER.tehsils,
    LAYER.tehsilsCasing,
    SRC.tehsils,
    lines.tehsils,
    state.adminLayers.tehsils ? "visible" : "none",
    { "line-dasharray": [3, 2] },
  );
  boundaryPair(
    LAYER.ilrs,
    LAYER.ilrsCasing,
    SRC.ilrs,
    lines.ilrs,
    state.adminLayers.ilrs ? "visible" : "none",
    { "line-dasharray": [1, 1.5] },
  );

  // ---------------------------------------------------------- selection + scene footprint
  map.addLayer(
    {
      id: LAYER.sceneLine,
      type: "line",
      source: SRC.activeScene,
      paint: { "line-color": palette.accent, "line-width": 1.5, "line-dasharray": [4, 3] },
    },
    firstLabelId,
  );
  map.addLayer(
    {
      id: LAYER.selectionFill,
      type: "fill",
      source: SRC.selection,
      paint: { "fill-color": palette.accent, "fill-opacity": palette.accentFillOpacity },
    },
    firstLabelId,
  );
  map.addLayer(
    {
      id: LAYER.selectionLine,
      type: "line",
      source: SRC.selection,
      paint: { "line-color": palette.accent, "line-width": 2 },
    },
    firstLabelId,
  );
  // Loading shimmer over the selection bounds while live imagery renders.
  map.addLayer(
    {
      id: LAYER.shimmer,
      type: "fill",
      source: SRC.shimmer,
      layout: { visibility: "none" },
      paint: { "fill-color": palette.accent, "fill-opacity": SHIMMER_OPACITY[0] },
    },
    firstLabelId,
  );

  // ---------------------------------------------------------- imagery overlay
  if (typeof dataAdapter.getSceneImage === "function") {
    // cdse mode: rebuild live raster tiles for the active scene + selection.
    if (activeScene && selection) {
      const urlTemplate = buildTileUrlTemplate({
        scene: activeScene,
        areaId: selection.id,
        level: selection.level,
        composite: activeScene.composite,
      });
      const attribution = `Contains modified Copernicus Sentinel data ${activeScene.date.slice(0, 4)}`;
      mapRuntime.imagerySelectionKey = `${selection.level}:${selection.id}`;
      mapRuntime.imageryTilesUrl = urlTemplate;
      setImageryTiles(map, urlTemplate, attribution);
      if (state.imageryLoading) showShimmer(map, selection.geometry);
    }
  } else {
    // Mock mode: decorative placeholder overlay (active scene bbox, else Rajasthan).
    const addPlaceholder = (url: string) => {
      if (map.getSource(SRC.imagery)) return;
      const [west, south, east, north] = activeScene?.bbox ?? RAJASTHAN_BBOX;
      map.addSource(SRC.imagery, {
        type: "image",
        url,
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      });
      map.addLayer(
        {
          id: LAYER.imagery,
          type: "raster",
          source: SRC.imagery,
          layout: { visibility: state.imageryVisible ? "visible" : "none" },
          paint: { "raster-opacity": state.imageryOpacity },
        },
        LAYER.districts,
      );
    };
    if (mapRuntime.placeholderUrl) {
      addPlaceholder(mapRuntime.placeholderUrl);
    } else {
      void createPlaceholderImageryUrl().then((url) => {
        if (!url) return;
        mapRuntime.placeholderUrl = url;
        try {
          if (map.getSource(SRC.districts)) addPlaceholder(url);
        } catch {
          // Map disposed while the placeholder was loading.
        }
      });
    }
  }

  // ---------------------------------------------------------- admin boundary data (async, cached)
  const applyAdminData = (data: AdminBoundaryData) => {
    try {
      (map.getSource(SRC.districts) as GeoJSONSource | undefined)?.setData(data.districts);
      (map.getSource(SRC.tehsils) as GeoJSONSource | undefined)?.setData(data.tehsils);
      (map.getSource(SRC.ilrs) as GeoJSONSource | undefined)?.setData(data.ilrs);
    } catch {
      // Map disposed while boundaries were loading.
    }
  };
  const applyOutlineData = (feature: GeoJSON.Feature | null) => {
    try {
      (map.getSource(SRC.stateOutline) as GeoJSONSource | undefined)?.setData(
        feature ? featureCollection([feature]) : EMPTY_FEATURE_COLLECTION,
      );
    } catch {
      // Map disposed while the outline was unioning.
    }
  };

  const ensureBoundaryData = async () => {
    if (!mapRuntime.adminData) {
      if (!mapRuntime.adminLoad) mapRuntime.adminLoad = loadAdminBoundaries();
      mapRuntime.adminData = await mapRuntime.adminLoad;
    }
    applyAdminData(mapRuntime.adminData);

    // The state outline is one big union of every district — deliberately
    // computed after the individual boundaries so district lines never wait
    // on it, and only ever computed once per page load.
    if (!mapRuntime.outlineData) {
      if (!mapRuntime.outlineLoad) {
        mapRuntime.outlineLoad = buildStateOutline(mapRuntime.adminData.districts);
      }
      mapRuntime.outlineData = await mapRuntime.outlineLoad;
    }
    applyOutlineData(mapRuntime.outlineData);
  };
  void ensureBoundaryData().catch(() => undefined);

  // ---------------------------------------------------------- restore selection + footprint from store
  // (Data only — camera movement stays with the React effects so a style
  // reload never yanks the viewport.)
  const selectionSource = map.getSource(SRC.selection) as GeoJSONSource | undefined;
  selectionSource?.setData(
    selection
      ? featureCollection([
          toFeature({ level: selection.level, name: selection.name }, selection.geometry),
        ])
      : EMPTY_FEATURE_COLLECTION,
  );

  const footprintSource = map.getSource(SRC.activeScene) as GeoJSONSource | undefined;
  const footprintSceneId =
    state.hoveredSceneId ?? (state.sceneFootprintVisible ? activeScene?.id ?? null : null);
  const footprintScene = footprintSceneId
    ? state.scenes.find((candidate) => candidate.id === footprintSceneId)
    : null;
  footprintSource?.setData(
    footprintScene ? featureCollection([sceneToFeature(footprintScene)]) : EMPTY_FEATURE_COLLECTION,
  );

  // Compare mode: classified overlay + date-A tiles (restores after style reloads).
  addCompareLayers(map);
}

/** Re-applies theme-dependent paint (accent + boundary line colours/casings). */
function applyPalette(map: MapLibreMap, theme: ThemeId): void {
  const palette = MAP_PALETTES[theme];
  const lines = BOUNDARY_LINE_THEMES[theme];
  const lineLayer = (id: string, casingId: string, style: BoundaryLineStyle) => {
    if (map.getLayer(id)) {
      map.setPaintProperty(id, "line-color", style.color);
      map.setPaintProperty(id, "line-width", style.width);
    }
    if (map.getLayer(casingId)) {
      map.setPaintProperty(casingId, "line-color", style.haloColor);
      map.setPaintProperty(casingId, "line-width", style.haloWidth);
    }
  };
  lineLayer(LAYER.districts, LAYER.districtsCasing, lines.districts);
  lineLayer(LAYER.tehsils, LAYER.tehsilsCasing, lines.tehsils);
  lineLayer(LAYER.ilrs, LAYER.ilrsCasing, lines.ilrs);
  lineLayer(LAYER.stateLine, LAYER.stateCasing, lines.state);
  if (map.getLayer(LAYER.sceneLine)) {
    map.setPaintProperty(LAYER.sceneLine, "line-color", palette.accent);
  }
  if (map.getLayer(LAYER.selectionLine)) {
    map.setPaintProperty(LAYER.selectionLine, "line-color", palette.accent);
  }
  if (map.getLayer(LAYER.selectionFill)) {
    map.setPaintProperty(LAYER.selectionFill, "fill-color", palette.accent);
    map.setPaintProperty(LAYER.selectionFill, "fill-opacity", palette.accentFillOpacity);
  }
  if (map.getLayer(LAYER.shimmer)) {
    map.setPaintProperty(LAYER.shimmer, "fill-color", palette.accent);
  }
}

/**
 * The subtle Rajasthan outline is only drawn in the "All Rajasthan" view — as
 * soon as a district/tehsil/ILR is selected the selection highlight replaces it.
 */
function setOutlineVisibility(map: MapLibreMap, visible: boolean): void {
  const visibility = visible ? "visible" : "none";
  if (map.getLayer(LAYER.stateLine)) {
    map.setLayoutProperty(LAYER.stateLine, "visibility", visibility);
  }
  if (map.getLayer(LAYER.stateCasing)) {
    map.setLayoutProperty(LAYER.stateCasing, "visibility", visibility);
  }
}

/**
 * Prefer Latin endonyms on every symbol layer so labels in Pakistan, Nepal
 * and elsewhere render in English instead of local scripts.
 */
function applyLatinLabels(map: MapLibreMap) {
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    if (layer.type !== "symbol") continue;
    try {
      map.setLayoutProperty(layer.id, "text-field", [
        "coalesce",
        ["get", "name:latin"],
        ["get", "name:en"],
        ["get", "name"],
      ]);
    } catch {
      // Some style layers reject text-field overrides; skip them.
    }
  }
}

async function loadAdminBoundaries(): Promise<AdminBoundaryData> {
  const districts = await dataAdapter.getDistricts();
  const tehsilGroups = await Promise.all(districts.map((d) => dataAdapter.getTehsils(d.id)));
  const tehsils = tehsilGroups.flat();
  const ilrGroups = await Promise.all(tehsils.map((t) => dataAdapter.getIlrs(t.id)));
  const ilrs = ilrGroups.flat();

  return {
    districts: featureCollection(
      districts.map((d) => toFeature({ id: d.id, name: d.name }, d.geometry)),
    ),
    tehsils: featureCollection(
      tehsils.map((t) =>
        toFeature({ id: t.id, name: t.name, districtId: t.districtId }, t.geometry),
      ),
    ),
    ilrs: featureCollection(
      ilrs.map((i) =>
        toFeature({ id: i.id, name: i.name, tehsilId: i.tehsilId, districtId: i.districtId }, i.geometry),
      ),
    ),
  };
}

/**
 * Outer boundary of Rajasthan = union of every district polygon. Cached after
 * the first computation; yields to the event loop every few districts so the
 * clipper can never freeze the map for long.
 */
async function buildStateOutline(
  districts: GeoJSON.FeatureCollection,
): Promise<GeoJSON.Feature | null> {
  let accumulated: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = null;
  const features = districts.features.filter(
    (feature) =>
      feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon",
  );

  for (let index = 0; index < features.length; index++) {
    const feature = features[index]!;
    if (!accumulated) {
      accumulated = {
        type: "Feature",
        properties: {},
        geometry: feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon,
      };
      continue;
    }
    try {
      const merged = union(
        turfFeatureCollection([accumulated, feature as typeof accumulated]),
      );
      if (merged) accumulated = merged as typeof accumulated;
    } catch {
      // A district that fails to clip is skipped — we keep the outline so far.
    }
    if (index % 8 === 7) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return accumulated;
}

function sceneToFeature(scene: Scene): GeoJSON.Feature {
  return toFeature(
    { id: scene.id, sceneId: scene.sceneId, cloudCover: scene.cloudCover, date: scene.date },
    scene.footprint ?? bboxToPolygon(scene.bbox),
  );
}

/**
 * Adds or updates the native-resolution raster tile source
 * (/api/tiles/{z}/{x}/{y}.png). Switching scene/composite calls setTiles() on
 * the existing source; raster-fade-duration crossfades old → new tiles.
 */
function setImageryTiles(
  map: MapLibreMap,
  urlTemplate: string,
  attribution: string,
): void {
  const existing = map.getSource(SRC.imagery) as RasterTileSource | undefined;
  if (existing && typeof existing.setTiles === "function") {
    existing.setTiles([urlTemplate]);
    return;
  }
  removeImagerySource(map);
  map.addSource(SRC.imagery, {
    type: "raster",
    tiles: [urlTemplate],
    tileSize: 512,
    minzoom: 7,
    maxzoom: 14,
    attribution,
  });
  // Insert below admin/selection outlines so the polygon stays on top.
  map.addLayer(
    {
      id: LAYER.imagery,
      type: "raster",
      source: SRC.imagery,
      layout: {
        visibility: useAppStore.getState().imageryVisible ? "visible" : "none",
      },
      paint: {
        "raster-opacity": useAppStore.getState().imageryOpacity,
        "raster-fade-duration": 200,
      },
    },
    map.getLayer(LAYER.districts) ? LAYER.districts : undefined,
  );
}

function removeImagerySource(map: MapLibreMap) {
  if (map.getLayer(LAYER.imagery)) map.removeLayer(LAYER.imagery);
  if (map.getSource(SRC.imagery)) map.removeSource(SRC.imagery);
}

const SHIMMER_OPACITY = [0.08, 0.18] as const;

function showShimmer(map: MapLibreMap, geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon) {
  const source = map.getSource(SRC.shimmer) as GeoJSONSource | undefined;
  if (!source) return;
  source.setData(featureCollection([toFeature({}, geometry)]));
  if (map.getLayer(LAYER.shimmer)) {
    map.setLayoutProperty(LAYER.shimmer, "visibility", "visible");
  }
}

function hideShimmer(map: MapLibreMap) {
  if (map.getLayer(LAYER.shimmer)) {
    map.setLayoutProperty(LAYER.shimmer, "visibility", "none");
    map.setPaintProperty(LAYER.shimmer, "fill-opacity", SHIMMER_OPACITY[0]);
  }
  const source = map.getSource(SRC.shimmer) as GeoJSONSource | undefined;
  source?.setData(EMPTY_FEATURE_COLLECTION);
}

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const geolocateMarkerRef = useRef<{ remove: () => void } | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isDesktop = useIsDesktop();
  const theme = useTheme((s) => s.theme);
  const palette = MAP_PALETTES[theme];

  const basemap = useAppStore((s) => s.basemap);
  const adminLayers = useAppStore((s) => s.adminLayers);
  const imageryVisible = useAppStore((s) => s.imageryVisible);
  const imageryOpacity = useAppStore((s) => s.imageryOpacity);
  const imageryLoading = useAppStore((s) => s.imageryLoading);
  const imageryError = useAppStore((s) => s.imageryError);
  const sceneFootprintVisible = useAppStore((s) => s.sceneFootprintVisible);
  const hoveredSceneId = useAppStore((s) => s.hoveredSceneId);
  const measureActive = useAppStore((s) => s.measureActive);
  const homeNonce = useAppStore((s) => s.homeNonce);
  const locateNonce = useAppStore((s) => s.locateNonce);
  const stripOpen = useAppStore((s) => s.resultsOpen);
  const stripHeightPx = useAppStore((s) => s.stripHeightPx);
  const toggleImageryStore = useAppStore((s) => s.toggleImagery);
  const selection = useActiveSelection();
  const activeScene = useActiveScene();
  const supportsLiveImagery = typeof dataAdapter.getSceneImage === "function";

  // ------------------------------------------------ map bootstrap
  useEffect(() => {
    let disposed = false;
    let map: MapLibreMap | null = null;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (disposed || !containerRef.current) return;

      map = new maplibregl.Map({
        container: containerRef.current,
        style: POSITRON_STYLE_URL,
        center: HOME_VIEW.center,
        zoom: HOME_VIEW.zoom,
        attributionControl: false,
        preserveDrawingBuffer: true,
      });
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");
      mapRef.current = map;
      registerMainMap(map);

      const container = containerRef.current;
      resizeObserver = new ResizeObserver(() => map?.resize());
      resizeObserver.observe(container);

      // `style.load` fires on the initial style AND after any setStyle —
      // MapLibre drops custom layers in both cases, so addAppLayers() (the
      // single builder that restores everything from the store) re-runs on
      // every occurrence. The handler is idempotent per loaded style.
      const onStyleLoad = () => {
        if (disposed || !mapRef.current) return;
        addAppLayers(mapRef.current);
        setReady(true);
      };
      map.on("style.load", onStyleLoad);
      map.on("load", onStyleLoad);

      map.on("error", (event) => {
        if (event?.error?.message) {
          // eslint-disable-next-line no-console
          console.warn("[map]", event.error.message);
        }
      });
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      geolocateMarkerRef.current?.remove();
      geolocateMarkerRef.current = null;
      if (mapRuntime.shimmerTimer !== null) {
        window.clearTimeout(mapRuntime.shimmerTimer);
        mapRuntime.shimmerTimer = null;
      }
      if (map) unregisterMainMap(map);
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // ------------------------------------------------ basemap toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const isSatellite = basemap === "satellite";
    for (const layer of mapRuntime.baseLayers) {
      map.setLayoutProperty(layer.id, "visibility", isSatellite ? "none" : layer.visibility);
    }
    if (map.getLayer(LAYER.satellite)) {
      map.setLayoutProperty(LAYER.satellite, "visibility", isSatellite ? "visible" : "none");
    }
  }, [ready, basemap]);

  // ------------------------------------------------ theme palette
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    applyPalette(map, theme);
  }, [ready, theme]);

  // ------------------------------------------------ admin layer toggles
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const setPair = (lineId: string, casingId: string, on: boolean) => {
      const visibility = on ? "visible" : "none";
      if (map.getLayer(lineId)) map.setLayoutProperty(lineId, "visibility", visibility);
      if (map.getLayer(casingId)) map.setLayoutProperty(casingId, "visibility", visibility);
    };
    setPair(LAYER.districts, LAYER.districtsCasing, adminLayers.districts);
    setPair(LAYER.tehsils, LAYER.tehsilsCasing, adminLayers.tehsils);
    setPair(LAYER.ilrs, LAYER.ilrsCasing, adminLayers.ilrs);
  }, [ready, adminLayers]);

  // ------------------------------------------------ imagery overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer(LAYER.imagery)) return;
    map.setLayoutProperty(LAYER.imagery, "visibility", imageryVisible ? "visible" : "none");
  }, [ready, imageryVisible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer(LAYER.imagery)) return;
    map.setPaintProperty(LAYER.imagery, "raster-opacity", imageryOpacity);
  }, [ready, imageryOpacity]);

  // ------------------------------------------------ area selection
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    // State outline belongs to the "All Rajasthan" view only.
    setOutlineVisibility(map, !selection);
    const source = map.getSource(SRC.selection) as GeoJSONSource | undefined;
    if (!source) return;

    if (!selection) {
      source.setData(EMPTY_FEATURE_COLLECTION);
      // Cleared → back to the state-wide view (padding 48px per spec).
      map.fitBounds(bboxToBounds(RAJASTHAN_BBOX), {
        padding: 48,
        duration: 600,
        maxZoom: 8,
      });
      return;
    }

    source.setData(
      featureCollection([toFeature({ level: selection.level, name: selection.name }, selection.geometry)]),
    );
    map.fitBounds(bboxToBounds(selection.bbox), {
      padding: 48,
      duration: 600,
      maxZoom: selection.level === "district" ? 10 : 11,
    });
  }, [ready, selection, isDesktop]);

  // ------------------------------------------------ scene footprint outline
  // Hidden by default: shows the hovered scene card's tile footprint, or the
  // active scene's footprint while the Layers-tab toggle is on.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const source = map.getSource(SRC.activeScene) as GeoJSONSource | undefined;
    if (!source) return;
    const scenes = useAppStore.getState().scenes;
    const footprintSceneId =
      hoveredSceneId ?? (sceneFootprintVisible ? activeScene?.id ?? null : null);
    const scene = footprintSceneId
      ? scenes.find((candidate) => candidate.id === footprintSceneId)
      : null;
    if (!scene) {
      source.setData(EMPTY_FEATURE_COLLECTION);
      return;
    }
    source.setData(featureCollection([sceneToFeature(scene)]));
  }, [ready, hoveredSceneId, sceneFootprintVisible, activeScene?.id, activeScene]);

  // ------------------------------------------------ active scene (selection side-effects)
  useEffect(() => {
    if (!ready || !activeScene) {
      useAppStore.getState().setImageryError(null);
      return;
    }
    // Mock mode: reposition the placeholder overlay to the scene bbox.
    if (!supportsLiveImagery) {
      const map = mapRef.current;
      const imagery = map?.getSource(SRC.imagery) as ImageSource | undefined;
      if (imagery) {
        const [west, south, east, north] = activeScene.bbox;
        imagery.setCoordinates([
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ]);
      }
    }
    if (!useAppStore.getState().imageryVisible) toggleImageryStore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeScene?.id]);

  // ------------------------------------------------ native tile imagery (cdse)
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !supportsLiveImagery) return;

    // Cleared scene or selection: drop the tile layer entirely.
    if (!activeScene || !selection) {
      removeImagerySource(map);
      hideShimmer(map);
      mapRuntime.imageryTilesUrl = null;
      mapRuntime.imagerySelectionKey = null;
      useAppStore.getState().setImageryError(null);
      useAppStore.getState().setImageryLoading(false);
      return;
    }

    const requestId = ++mapRuntime.liveRequest;
    const { setImageryLoading } = useAppStore.getState();
    setImageryLoading(true);

    const urlTemplate = buildTileUrlTemplate({
      scene: activeScene,
      areaId: selection.id,
      level: selection.level,
      composite: activeScene.composite,
    });
    const year = activeScene.date.slice(0, 4);
    const attribution = `Contains modified Copernicus Sentinel data ${year}`;

    // Selection changed → previous tiles belong to another polygon: rebuild
    // the source so bounds/attribution reset cleanly.
    const selectionKey = `${selection.level}:${selection.id}`;
    if (mapRuntime.imagerySelectionKey !== selectionKey || mapRuntime.imageryTilesUrl === null) {
      removeImagerySource(map);
      mapRuntime.imagerySelectionKey = selectionKey;
      mapRuntime.imageryTilesUrl = null;
    }

    setImageryTiles(map, urlTemplate, attribution);
    mapRuntime.imageryTilesUrl = urlTemplate;
    showShimmer(map, selection.geometry);

    // Shimmer/loading clears when tiles finish rendering (first idle), with a
    // safety timeout so a dead network never leaves the spinner up forever.
    const finish = () => {
      if (requestId !== mapRuntime.liveRequest) return;
      map.off("idle", finish);
      if (mapRuntime.shimmerTimer !== null) {
        window.clearTimeout(mapRuntime.shimmerTimer);
        mapRuntime.shimmerTimer = null;
      }
      hideShimmer(map);
      setImageryLoading(false);
    };
    map.on("idle", finish);
    mapRuntime.shimmerTimer = window.setTimeout(finish, 6000);

    return () => {
      map.off("idle", finish);
      if (mapRuntime.shimmerTimer !== null) {
        window.clearTimeout(mapRuntime.shimmerTimer);
        mapRuntime.shimmerTimer = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, supportsLiveImagery, activeScene?.id, activeScene?.composite, selection?.id, selection?.level]);

  // ------------------------------------------------ home control
  useEffect(() => {
    if (!ready || homeNonce === 0) return;
    mapRef.current?.flyTo({ ...HOME_VIEW, duration: 600 });
  }, [ready, homeNonce]);

  // ------------------------------------------------ locate me
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || locateNonce === 0 || !map) return;

    if (!navigator.geolocation) {
      setNotice("Geolocation is not supported by this browser.");
      return;
    }

    setNotice("Locating…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const current = mapRef.current;
        if (!current) return;
        const lngLat: [number, number] = [position.coords.longitude, position.coords.latitude];
        current.flyTo({ center: lngLat, zoom: 11, duration: 600 });
        void import("maplibre-gl").then((maplibregl) => {
          geolocateMarkerRef.current?.remove();
          geolocateMarkerRef.current = new maplibregl.default.Marker({ color: palette.accent })
            .setLngLat(lngLat)
            .addTo(current);
        });
        setNotice(null);
      },
      (error) => {
        setNotice(`Location unavailable (${error.message})`);
      },
      { enableHighAccuracy: true, timeout: 9000 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, locateNonce]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  // ------------------------------------------------ controls
  const handleZoomIn = useCallback(() => mapRef.current?.zoomIn({ duration: 250 }), []);
  const handleZoomOut = useCallback(() => mapRef.current?.zoomOut({ duration: 250 }), []);
  const handleHome = useCallback(() => useAppStore.getState().requestHome(), []);
  const handleLocate = useCallback(() => useAppStore.getState().requestLocate(), []);
  const handleFullscreen = useCallback(() => {
    const shell = containerRef.current?.closest(".map-shell");
    if (!shell) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void shell.requestFullscreen?.();
    }
  }, []);
  const handleScreenshot = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const url = map.getCanvas().toDataURL("image/png");
      const link = document.createElement("a");
      link.href = url;
      link.download = `rajasthan-explorer-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      link.click();
      setNotice("Screenshot downloaded.");
    } catch {
      setNotice("Screenshot failed in this browser.");
    }
  }, []);

  // Map controls sit just above the results strip — the strip sizes to its
  // content, so the offsets follow the measured height from the store.
  const leftBottomStyle = { bottom: stripOpen ? stripHeightPx + 56 : 56 };
  const rightBottomStyle = { bottom: stripOpen ? stripHeightPx + 12 : 12 };
  const legendStyle = { bottom: stripOpen ? stripHeightPx + 40 : 48 };

  return (
    <div
      className={`map-shell relative h-full w-full overflow-hidden bg-surface-2 ${measureActive ? "cursor-crosshair" : ""}`}
      data-strip={stripOpen ? "open" : "closed"}
      style={{ "--strip-h": `${stripHeightPx}px` } as React.CSSProperties}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {ready ? (
        <>
          <AddressSearch mapRef={mapRef} />
          <MapControls
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onHome={handleHome}
            onLocate={handleLocate}
            onFullscreen={handleFullscreen}
            onScreenshot={handleScreenshot}
          />
          <div className="absolute left-3 z-20 flex items-end gap-2 transition-[bottom] duration-150 ease-out" style={leftBottomStyle}>
            <BasemapSwitcher />
            <LegendControl />
          </div>
          <CursorCoords
            mapRef={mapRef}
            className="absolute right-3 z-10 transition-[bottom] duration-150 ease-out"
            style={rightBottomStyle}
          />

          {supportsLiveImagery && activeScene && imageryVisible && (
            <CompositeLegendBar
              composite={activeScene.composite}
              className="absolute right-3 z-10 transition-[bottom] duration-150 ease-out"
              style={legendStyle}
            />
          )}

          {measureActive && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-text">
              Measure tool armed — click the map to add points.
            </div>
          )}

          {imageryLoading && !measureActive && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-muted">
              Loading imagery…
            </div>
          )}

          {imageryError && (
            <div className="absolute left-1/2 top-3 z-30 flex max-w-[min(92vw,28rem)] -translate-x-1/2 items-center gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-text shadow-float">
              <span className="truncate">{imageryError}</span>
              <button
                type="button"
                aria-label="Dismiss imagery error"
                className="shrink-0 text-muted transition-colors duration-150 hover:text-text"
                onClick={() => useAppStore.getState().setImageryError(null)}
              >
                ✕
              </button>
            </div>
          )}

          {notice && (
            <div className="pointer-events-none absolute bottom-14 left-1/2 z-20 -translate-x-1/2 rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-text">
              {notice}
            </div>
          )}
        </>
      ) : (
        <div className="absolute inset-0 z-30 grid place-items-center bg-bg">
          <p className="mono-nums text-xs text-muted">Loading map…</p>
        </div>
      )}
    </div>
  );
}
