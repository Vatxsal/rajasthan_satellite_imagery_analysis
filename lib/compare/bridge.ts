import type {
  ExpressionSpecification,
  GeoJSONSource,
  ImageSource,
  Map as MapLibreMap,
  MapGeoJSONFeature,
} from "maplibre-gl";
import { bboxFromGeometry, type ClipGeometry } from "@/lib/cdse/geometry";
import { CLASS_DEFS, classColor } from "@/lib/analysis/config";
import type { Hotspot } from "@/lib/analysis/types";
import { selectVisibleEvents } from "@/lib/compare/eventList";
import { bboxToBounds } from "@/lib/map/geojson";
import { MAP_PALETTES } from "@/lib/map/palette";
import { useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { useTheme } from "@/store/useTheme";

/**
 * Compare-mode map bridge: module state + a registry for the single main map
 * instance (MapCanvas registers it), so compare layers can be driven from the
 * compare store without prop-drilling through MapCanvas.
 *
 * Layer stack (bottom → top), all rebuilt from the store on every style.load:
 *  - "compare-overlay-layer"  classified change PNG     (every tab except Swipe)
 *  - "compare-choropleth"     per-tehsil alpha shading  (toggle, district level)
 *  - "compare-tehsil-highlight" clicked tehsil outline
 *  - "compare-hotspot-fill/line/hover"  top-10 patch polygons
 *  - above the AOI outline/shimmer, below the labels:
 * Numbered 22px hotspot markers are DOM elements (maplibre Marker) layered
 * above the canvas and styled in globals.css (.hs-marker).
 *
 * Swipe tab: raw date-A and date-B tiles live on two clean secondary maps
 * (CompareMapController) clipped left/right of the divider — the main map is
 * covered underneath and only drives the camera. Anchors: everything thematic
 * sits directly above the basemap/imagery and below the boundary lines +
 * labels ("districts-line"), so boundaries and names stay readable over the
 * overlay.
 */

const SRC = {
  overlay: "compare-overlay",
  hotspotPolys: "compare-hotspot-polygons",
} as const;

const LAYER = {
  overlay: "compare-overlay-layer",
  choropleth: "compare-choropleth",
  tehsilHighlight: "compare-tehsil-highlight",
  hotspotFill: "compare-hotspot-fill",
  hotspotLine: "compare-hotspot-line",
  hotspotHover: "compare-hotspot-hover",
} as const;

/** Legacy canvas-circle/symbol marker artifacts — stripped if a stale map has them. */
const LEGACY_MARKER_LAYERS = ["compare-hotspot-circle", "compare-hotspot-rank"];
const LEGACY_MARKER_SRC = "compare-hotspot-points";

const HOTSPOT_LAYERS: string[] = [LAYER.hotspotFill, LAYER.hotspotLine, LAYER.hotspotHover];

/** Anchors just above the basemap/imagery, below boundaries and labels. */
const ANCHOR_BELOW = "districts-line";
/** Anchors directly below the basemap's label layers (top of the stack). */
const TEHSIL_SRC = "admin-tehsils";

type CompareCoords = [[number, number], [number, number], [number, number], [number, number]];

let mainMap: MapLibreMap | null = null;
/** Recoloured overlay image (blob URL) — null → serve the original PNG. */
let displayOverlayUrl: string | null = null;
/** URL + bbox currently applied to the image source (avoids refetch churn). */
let appliedOverlayUrl: string | null = null;
let appliedOverlayBbox: string | null = null;
/** Result key the display URL belongs to — reset when a new run lands. */
let displayKey: string | null = null;
/** Result bbox already framed after its run (fit once per result). */
let fittedResultKey: string | null = null;

/**
 * Dev-only: expose live MapLibre instances on `window.__rieMaps` so browser
 * verification scripts can dump styles/layers/paint without a public API.
 * No-op in production builds.
 */
export function setDebugMap(slot: "main" | "left" | "right", map: MapLibreMap | null): void {
  if (process.env.NODE_ENV === "production") return;
  const g = window as unknown as {
    __rieMaps?: Partial<Record<"main" | "left" | "right", MapLibreMap>>;
  };
  if (!g.__rieMaps) g.__rieMaps = {};
  if (map) g.__rieMaps[slot] = map;
  else delete g.__rieMaps[slot];
}

/** Maps whose delegated hotspot events are already bound. */
const hotspotEventsBound = new WeakSet<MapLibreMap>();
let hotspotPopup: import("maplibre-gl").Popup | null = null;

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

function firstLabelId(map: MapLibreMap): string | undefined {
  return (map.getStyle().layers ?? []).find((layer) => layer.type === "symbol")?.id;
}

function layerAnchor(map: MapLibreMap): string | undefined {
  if (map.getLayer(ANCHOR_BELOW)) return ANCHOR_BELOW;
  return firstLabelId(map);
}

/** Adds a layer below the boundary lines when possible, else below labels. */
function addThematicLayer(
  map: MapLibreMap,
  layer: Parameters<MapLibreMap["addLayer"]>[0],
  anchor?: string,
): void {
  try {
    const before = anchor ?? layerAnchor(map);
    if (before && map.getLayer(before)) map.addLayer(layer, before);
    else map.addLayer(layer);
  } catch {
    // Style rejected the layer — sync will retry after the next style.load.
  }
}

function outlineRgb(theme: "light" | "dark"): [number, number, number] {
  return theme === "light" ? [22, 24, 30] : [255, 255, 255];
}

function rgbCss(color: [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/** match(classCode → color) expression shared by hotspot fills and markers. */
function classColorExpression(fallback: string): ExpressionSpecification {
  const stops: Array<number | string> = [];
  for (const def of CLASS_DEFS) {
    if (!def.change) continue;
    stops.push(def.code, rgbCss(def.color));
  }
  return ["match", ["get", "classCode"], ...stops, fallback] as unknown as ExpressionSpecification;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function removeSourceLayer(map: MapLibreMap, sourceId: string, layerIds: string[]): void {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/** Classified overlay image source — visibility follows the active tab. */
function syncOverlay(map: MapLibreMap): void {
  const state = useCompareStore.getState();
  const result = state.result;
  if (!result) {
    removeSourceLayer(map, SRC.overlay, [LAYER.overlay]);
    appliedOverlayUrl = null;
    appliedOverlayBbox = null;
    return;
  }

  const wantedUrl = displayOverlayUrl ?? result.overlayUrl;
  const bboxKey = result.bbox.join(",");
  const visible = state.tab !== "swipe" ? "visible" : "none";
  const existing = map.getSource(SRC.overlay) as ImageSource | undefined;

  if (!existing) {
    map.addSource(SRC.overlay, { type: "image", url: wantedUrl, coordinates: imageCoords(result.bbox) });
    appliedOverlayUrl = wantedUrl;
    appliedOverlayBbox = bboxKey;
    addThematicLayer(
      map,
      {
        id: LAYER.overlay,
        type: "raster",
        source: SRC.overlay,
        layout: { visibility: visible },
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
    map.setLayoutProperty(LAYER.overlay, "visibility", visible);
    map.setPaintProperty(LAYER.overlay, "raster-opacity", state.overlayOpacity);
  }
}

/** Per-tehsil alpha shading from the zonal stats (district-level results). */
function syncChoropleth(map: MapLibreMap): void {
  const state = useCompareStore.getState();
  const result = state.result;
  const rows = result?.stats.tehsils ?? [];
  const wanted =
    Boolean(result) && state.choropleth && state.tab !== "swipe" && rows.length > 0;

  if (!wanted || !map.getLayer(LAYER.choropleth)) {
    if (map.getLayer(LAYER.choropleth)) {
      map.setLayoutProperty(LAYER.choropleth, "visibility", "none");
    }
    return;
  }

  const max = rows.reduce((acc, row) => Math.max(acc, row.changedHa), 0.0001);
  const stops: unknown[] = [];
  for (const row of rows) {
    if (row.changedHa <= 0) continue;
    const t = Math.sqrt(row.changedHa / max);
    const alpha = (0.12 + 0.55 * t).toFixed(3);
    stops.push(row.tehsilId, `rgba(37, 99, 235, ${alpha})`);
  }
  if (stops.length === 0) {
    map.setLayoutProperty(LAYER.choropleth, "visibility", "none");
    return;
  }
  const expression = ["match", ["get", "id"], ...stops, "rgba(37, 99, 235, 0)"] as unknown;
  map.setPaintProperty(LAYER.choropleth, "fill-color", expression);
  map.setLayoutProperty(LAYER.choropleth, "visibility", "visible");
}

function ensureChoroplethLayer(map: MapLibreMap): void {
  if (map.getLayer(LAYER.choropleth)) return;
  if (!map.getSource(TEHSIL_SRC)) return;
  addThematicLayer(
    map,
    {
      id: LAYER.choropleth,
      type: "fill",
      source: TEHSIL_SRC,
      layout: { visibility: "none" },
      paint: { "fill-color": "rgba(37, 99, 235, 0)", "fill-opacity": 1 },
    },
    layerAnchor(map),
  );
}

/** Clicked tehsil from the stats table — fill + outline, cleared by re-click. */
function syncTehsilHighlight(map: MapLibreMap): void {
  const state = useCompareStore.getState();
  const highlight = state.tehsilHighlight;

  if (!map.getLayer(LAYER.tehsilHighlight)) {
    if (!highlight || !map.getSource(TEHSIL_SRC)) return;
    addThematicLayer(
      map,
      {
        id: LAYER.tehsilHighlight,
        type: "fill",
        source: TEHSIL_SRC,
        layout: { visibility: "visible" },
        paint: {
          "fill-color": MAP_PALETTES[useTheme.getState().theme].accent,
          "fill-opacity": 0.3,
          "fill-outline-color": MAP_PALETTES[useTheme.getState().theme].accent,
        },
      },
      layerAnchor(map),
    );
    return;
  }

  if (!highlight) {
    map.setLayoutProperty(LAYER.tehsilHighlight, "visibility", "none");
    return;
  }
  map.setFilter(LAYER.tehsilHighlight, ["==", ["get", "id"], highlight.id]);
  map.setLayoutProperty(LAYER.tehsilHighlight, "visibility", "visible");
}

/**
 * Visible list rows — the single source for map polygons AND numbered
 * markers. Uses the exact helper CompareStatsTab renders with (same store
 * slice: eventsItems + confidence filter + client cursor), so list rank N
 * and marker rank N are the same feature by construction.
 */
function visibleEvents(): GeoJSON.Feature[] {
  const state = useCompareStore.getState();
  if (!state.result) return [];
  return selectVisibleEvents(state.eventsItems, {
    confidenceFilter: state.confidenceFilter,
    limit: state.eventsLimit,
  });
}

function eventPolygonFeatures(events: GeoJSON.Feature[]): GeoJSON.Feature[] {
  const polygons: GeoJSON.Feature[] = [];
  events.forEach((event, index) => {
    const geometry = event.geometry;
    if (!geometry || (geometry.type !== "MultiPolygon" && geometry.type !== "Polygon")) return;
    const props = (event.properties ?? {}) as Record<string, unknown>;
    polygons.push({
      type: "Feature",
      properties: {
        rank: index + 1,
        classCode: Number(props.classCode ?? -1),
        classLabel: String(props.classLabel ?? "Change"),
        areaHa: Number(props.areaHa ?? 0),
        tehsilName: typeof props.tehsilName === "string" ? props.tehsilName : "",
      },
      geometry,
    });
  });
  return polygons;
}

function removeLegacyMarkerLayers(map: MapLibreMap): void {
  for (const layerId of LEGACY_MARKER_LAYERS) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(LEGACY_MARKER_SRC)) map.removeSource(LEGACY_MARKER_SRC);
}

function syncHotspots(map: MapLibreMap): void {
  const state = useCompareStore.getState();
  const result = state.result;
  const wanted = Boolean(result) && state.tab !== "swipe";
  const theme = useTheme.getState().theme;
  const outline = outlineRgb(theme);
  const hoverRank = state.hoveredHotspot ?? -1;

  removeLegacyMarkerLayers(map);

  if (!wanted || !result) {
    for (const layerId of HOTSPOT_LAYERS) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
    }
    if (map.getSource(SRC.hotspotPolys)) {
      (map.getSource(SRC.hotspotPolys) as GeoJSONSource).setData({ type: "FeatureCollection", features: [] });
    }
    return;
  }

  const polygons = eventPolygonFeatures(visibleEvents());

  if (!map.getSource(SRC.hotspotPolys)) {
    map.addSource(SRC.hotspotPolys, {
      type: "geojson",
      data: { type: "FeatureCollection", features: polygons },
    });
    addThematicLayer(
      map,
      {
        id: LAYER.hotspotFill,
        type: "fill",
        source: SRC.hotspotPolys,
        layout: { visibility: "visible" },
        paint: {
          "fill-color": classColorExpression("rgba(0,0,0,0)"),
          "fill-opacity": 0.28,
        },
      },
      layerAnchor(map),
    );
    addThematicLayer(
      map,
      {
        id: LAYER.hotspotLine,
        type: "line",
        source: SRC.hotspotPolys,
        layout: { visibility: "visible" },
        paint: {
          "line-color": rgbCss(outline),
          "line-width": 1.5,
          "line-opacity": 0.9,
        },
      },
      layerAnchor(map),
    );
    addThematicLayer(
      map,
      {
        id: LAYER.hotspotHover,
        type: "line",
        source: SRC.hotspotPolys,
        layout: { visibility: "visible" },
        paint: {
          "line-color": MAP_PALETTES[theme].accent,
          "line-width": 3,
        },
      },
      layerAnchor(map),
    );
    if (map.getLayer(LAYER.hotspotHover)) {
      map.setFilter(LAYER.hotspotHover, ["==", ["get", "rank"], hoverRank]);
    }
    return;
  }
  (map.getSource(SRC.hotspotPolys) as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: polygons,
  });
  if (map.getLayer(LAYER.hotspotFill)) {
    map.setPaintProperty(LAYER.hotspotFill, "fill-color", classColorExpression("rgba(0,0,0,0)"));
    map.setLayoutProperty(LAYER.hotspotFill, "visibility", "visible");
  }
  if (map.getLayer(LAYER.hotspotLine)) {
    map.setPaintProperty(LAYER.hotspotLine, "line-color", rgbCss(outline));
    map.setLayoutProperty(LAYER.hotspotLine, "visibility", "visible");
  }
  if (map.getLayer(LAYER.hotspotHover)) {
    map.setPaintProperty(LAYER.hotspotHover, "line-color", MAP_PALETTES[theme].accent);
    map.setFilter(LAYER.hotspotHover, ["==", ["get", "rank"], hoverRank]);
    map.setLayoutProperty(LAYER.hotspotHover, "visibility", "visible");
  }
}

// --------------------------------------------------------- DOM markers
interface HotspotMarkerEntry {
  marker: import("maplibre-gl").Marker;
  el: HTMLElement;
  rank: number;
}

let hotspotMarkers: HotspotMarkerEntry[] = [];
/** Signature of the current marker set (result × filter × cursor × count) —
 *  rebuild only when it changes; hover/selection changes just restyle. */
let markerSig: string | null = null;
let markerSyncSeq = 0;
type MapLibreBits = {
  Marker: typeof import("maplibre-gl").Marker;
  Popup: typeof import("maplibre-gl").Popup;
};
let maplibreLoader: Promise<MapLibreBits> | null = null;
let popupEscBound = false;

function loadMaplibre(): Promise<MapLibreBits> {
  return (maplibreLoader ??= import("maplibre-gl").then((module) => {
    const { Marker, Popup } = module.default;
    return { Marker, Popup };
  }));
}

/** Light/dark text choice so the rank stays legible on the class fill. */
function markerTextColor(color: [number, number, number]): string {
  const [r, g, b] = color;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? "#1b1d22" : "#ffffff";
}

function removeHotspotMarkers(): void {
  for (const entry of hotspotMarkers) entry.marker.remove();
  hotspotMarkers = [];
  markerSig = null;
}

function applyMarkerState(entry: HotspotMarkerEntry): void {
  const { hoveredHotspot, selectedHotspot } = useCompareStore.getState();
  entry.el.dataset.state =
    entry.rank === selectedHotspot ? "selected" : entry.rank === hoveredHotspot ? "hover" : "";
}

function onMarkerClick(rank: number): void {
  const hotspot = selectedHotspotAt(rank);
  const map = mainMap;
  if (!hotspot || !map) return;
  useCompareStore.getState().setSelectedHotspot(rank);
  map.flyTo({ center: hotspot.centroid, zoom: Math.max(map.getZoom(), 15), duration: 500 });
  void openHotspotPopup(rank);
}

/**
 * Numbered 22px DOM markers (class fill + surface ring + Plex Mono rank).
 * One marker per visible list row — built from the same event features the
 * Events tab renders, so ranks always match. Hover/selected state follows the
 * store so list and map highlight each other. Async because maplibre loads on
 * demand.
 */
async function syncHotspotMarkers(map: MapLibreMap): Promise<void> {
  const seq = ++markerSyncSeq;
  const state = useCompareStore.getState();
  const result = state.result;
  const wanted = Boolean(result) && state.tab !== "swipe";
  if (!wanted || !result) {
    removeHotspotMarkers();
    return;
  }
  const maplibregl = await loadMaplibre();
  if (seq !== markerSyncSeq || mainMap !== map) return; // superseded mid-load

  const events = visibleEvents();
  const nextSig = `${result.key}|${state.confidenceFilter ?? "all"}|${state.eventsLimit}|${events.length}`;
  if (markerSig !== nextSig) {
    removeHotspotMarkers();
    markerSig = nextSig;
    events.forEach((event, index) => {
      const rank = index + 1;
      const props = (event.properties ?? {}) as Record<string, unknown>;
      const centroid = props.centroid as number[] | undefined;
      if (!Array.isArray(centroid) || centroid.length !== 2) return;
      const classCode = Number(props.classCode ?? -1);
      const classLabel = String(props.classLabel ?? "Change");
      const areaHa = Number(props.areaHa ?? 0);
      const color = classColor(classCode);
      const el = document.createElement("button");
      el.type = "button";
      el.className = "hs-marker";
      el.textContent = String(rank);
      el.style.setProperty("--hs", rgbCss(color));
      el.style.setProperty("--hs-fg", markerTextColor(color));
      el.setAttribute(
        "aria-label",
        `Change event ${rank}: ${classLabel}, ${areaHa.toLocaleString("en", { maximumFractionDigits: 1 })} hectares`,
      );
      el.addEventListener("mouseenter", () => useCompareStore.getState().setHoveredHotspot(rank));
      el.addEventListener("mouseleave", () => useCompareStore.getState().setHoveredHotspot(null));
      el.addEventListener("focus", () => useCompareStore.getState().setHoveredHotspot(rank));
      el.addEventListener("blur", () => useCompareStore.getState().setHoveredHotspot(null));
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        onMarkerClick(rank);
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([centroid[0], centroid[1]])
        .addTo(map);
      hotspotMarkers.push({ marker, el, rank });
    });
  }
  for (const entry of hotspotMarkers) applyMarkerState(entry);
}


const POPUP_COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const POPUP_CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const POPUP_ZOOM_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/></svg>`;

function hotspotPopupHtml(
  properties: Record<string, unknown>,
  options: { showZoom: boolean },
): string {
  const rank = Number(properties.rank ?? 0);
  const label = String(properties.classLabel ?? "Change");
  const color = classColor(Number(properties.classCode ?? -1));
  const areaHa = Number(properties.areaHa ?? 0);
  const tehsil = String(properties.tehsilName ?? "");
  const hotspot = selectedHotspotAt(rank);
  const lon = hotspot?.centroid[0] ?? 0;
  const lat = hotspot?.centroid[1] ?? 0;
  const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  return (
    `<div class="hs-pop">` +
    `<div class="hs-pop-top">` +
    `<span class="hs-pop-chip" style="background:rgb(${color[0]},${color[1]},${color[2]})" aria-hidden="true"></span>` +
    `<span class="hs-pop-name">${escapeHtml(label)}</span>` +
    `<span class="hs-pop-rank">#${rank}</span>` +
    `</div>` +
    `<p class="hs-pop-area">${areaHa.toLocaleString("en", { maximumFractionDigits: 1 })} ha</p>` +
    `<div class="hs-pop-rows">` +
    (tehsil
      ? `<div class="hs-pop-row"><span class="k">Tehsil</span><span class="v">${escapeHtml(tehsil)}</span></div>`
      : "") +
    (hotspot?.confidence
      ? `<div class="hs-pop-row"><span class="k">Confidence</span><span class="v">${escapeHtml(hotspot.confidence)}${
          typeof hotspot.confidencePct === "number" ? ` · ${hotspot.confidencePct}%` : ""
        }</span></div>`
      : "") +
    (hotspot?.subLabel
      ? `<div class="hs-pop-row"><span class="k">Note</span><span class="v">${escapeHtml(hotspot.subLabel)}</span></div>`
      : "") +
    `<div class="hs-pop-row">` +
    `<span class="k">Centroid</span><span class="v mono">${coords}</span>` +
    `<button type="button" class="hs-pop-btn" data-copy-coords="${lat.toFixed(6)}, ${lon.toFixed(6)}" ` +
    `aria-label="Copy centroid coordinates">${POPUP_COPY_ICON}<span data-copy-label>Copy</span></button>` +
    `</div>` +
    `</div>` +
    (options.showZoom
      ? `<button type="button" class="hs-pop-btn hs-pop-zoom" data-zoom-in aria-label="Zoom in to this hotspot">${POPUP_ZOOM_ICON}Zoom in</button>`
      : "") +
    `</div>`
  );
}

/** Hotspot-shaped view of an event feature (the popup/fly-to consumers expect
 *  this shape; the raw properties carry every field the server vectorized). */
function featureToHotspot(feature: GeoJSON.Feature): Hotspot | null {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const centroidRaw = props.centroid as number[] | undefined;
  if (!Array.isArray(centroidRaw) || centroidRaw.length !== 2) return null;
  const centroid: [number, number] = [Number(centroidRaw[0]), Number(centroidRaw[1])];
  const bboxRaw = props.bbox as number[] | undefined;
  const bbox: [number, number, number, number] =
    Array.isArray(bboxRaw) && bboxRaw.length === 4
      ? [Number(bboxRaw[0]), Number(bboxRaw[1]), Number(bboxRaw[2]), Number(bboxRaw[3])]
      : [centroid[0] - 0.002, centroid[1] - 0.002, centroid[0] + 0.002, centroid[1] + 0.002];
  const geometry = feature.geometry;
  return {
    centroid,
    bbox,
    areaHa: Number(props.areaHa ?? 0),
    classCode: Number(props.classCode ?? -1),
    classLabel: String(props.classLabel ?? "Change"),
    tehsilName: typeof props.tehsilName === "string" && props.tehsilName ? props.tehsilName : null,
    polygon: geometry && geometry.type === "MultiPolygon" ? geometry : null,
    ...(typeof props.confidence === "string"
      ? { confidence: props.confidence as Hotspot["confidence"] }
      : {}),
    ...(typeof props.confidencePct === "number" && Number.isFinite(props.confidencePct)
      ? { confidencePct: Math.round(props.confidencePct) }
      : {}),
    ...(typeof props.subLabel === "string" ? { subLabel: props.subLabel } : {}),
    ...(Array.isArray(props.tags) ? { tags: props.tags as string[] } : {}),
  };
}

/** The event at list rank N (1-based) — identical to the row the list shows. */
function selectedHotspotAt(rank: number): Hotspot | null {
  const feature = visibleEvents()[rank - 1];
  if (!feature) return null;
  return featureToHotspot(feature);
}

/** Opens the numbered popup for a hotspot (list click or map click). */
async function openHotspotPopup(rank: number): Promise<void> {
  const hotspot = selectedHotspotAt(rank);
  const map = mainMap;
  if (!hotspot || !map) return;
  const maplibregl = await loadMaplibre();
  if (mainMap !== map) return;
  if (!hotspotPopup) {
    hotspotPopup = new maplibregl.Popup({
      closeButton: true,
      maxWidth: "260px",
      offset: 12,
    });
    hotspotPopup.on("open", () => {
      const element = hotspotPopup?.getElement();
      if (!element) return;
      element
        .querySelector(".maplibregl-popup-close-button")
        ?.setAttribute("aria-label", "Close hotspot details");
      const copyButton = element.querySelector<HTMLButtonElement>("[data-copy-coords]");
      copyButton?.addEventListener("click", () => {
        void navigator.clipboard?.writeText(copyButton.dataset.copyCoords ?? "").then(() => {
          const label = copyButton.querySelector<HTMLElement>("[data-copy-label]");
          const icon = copyButton.querySelector("svg");
          if (label) label.textContent = "Copied";
          if (icon) icon.outerHTML = POPUP_CHECK_ICON;
          window.setTimeout(() => {
            if (label) label.textContent = "Copy";
            const current = copyButton.querySelector("svg");
            if (current) current.outerHTML = POPUP_COPY_ICON;
          }, 1500);
        });
      });
      element.querySelector<HTMLElement>("[data-zoom-in]")?.addEventListener("click", () => {
        const currentMap = mainMap;
        const selected = useCompareStore.getState().selectedHotspot;
        const target = selected ? selectedHotspotAt(selected) : null;
        if (currentMap && target) {
          currentMap.flyTo({ center: target.centroid, zoom: Math.max(currentMap.getZoom(), 15), duration: 500 });
        }
      });
    });
    hotspotPopup.on("close", () => {
      useCompareStore.getState().setSelectedHotspot(null);
    });
  }
  if (!popupEscBound) {
    popupEscBound = true;
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !hotspotPopup) return;
      hotspotPopup.remove();
    });
  }
  hotspotPopup
    .setLngLat(hotspot.centroid)
    .setHTML(
      hotspotPopupHtml(
        {
          rank,
          classLabel: hotspot.classLabel,
          classCode: hotspot.classCode,
          areaHa: hotspot.areaHa,
          tehsilName: hotspot.tehsilName ?? "",
        },
        // Only offer the zoom-in shortcut when the view is not already close.
        { showZoom: map.getZoom() < 14 },
      ),
    )
    .addTo(map);
}

/** Binds delegated events once per map instance (survives style reloads). */
function bindHotspotEvents(map: MapLibreMap): void {
  if (hotspotEventsBound.has(map)) return;
  hotspotEventsBound.add(map);
  const canvas = map.getCanvas();

  const rankOf = (event: { features?: MapGeoJSONFeature[] }): number | null => {
    const feature = event.features?.[0];
    const rank = Number(feature?.properties?.rank);
    return Number.isFinite(rank) && rank > 0 ? rank : null;
  };

  const enter = (event: { features?: MapGeoJSONFeature[] }): void => {
    const rank = rankOf(event);
    if (rank === null) return;
    useCompareStore.getState().setHoveredHotspot(rank);
    canvas.style.cursor = "pointer";
  };
  const leave = (): void => {
    useCompareStore.getState().setHoveredHotspot(null);
    canvas.style.cursor = "";
  };
  const click = (event: { features?: MapGeoJSONFeature[] }): void => {
    const rank = rankOf(event);
    if (rank === null) return;
    const hotspot = selectedHotspotAt(rank);
    if (!hotspot) return;
    useCompareStore.getState().setSelectedHotspot(rank);
    map.flyTo({ center: hotspot.centroid, zoom: Math.max(map.getZoom(), 15), duration: 500 });
    void openHotspotPopup(rank);
  };

  map.on("mouseenter", LAYER.hotspotFill, enter);
  map.on("mouseleave", LAYER.hotspotFill, leave);
  map.on("click", LAYER.hotspotFill, click);

  map.on("click", (event) => {
    const hotspotLayerIds = HOTSPOT_LAYERS.filter((id) => map.getLayer(id));
    const ours =
      hotspotLayerIds.length > 0 &&
      map.queryRenderedFeatures(event.point, { layers: hotspotLayerIds }).length > 0;
    if (ours) return;
    hotspotPopup?.remove();
    useCompareStore.getState().setSelectedHotspot(null);
  });
}

function syncCompareMap(map: MapLibreMap): void {
  try {
    if (!map.isStyleLoaded()) return; // style.load → addAppLayers → addCompareLayers
    syncOverlay(map);
    ensureChoroplethLayer(map);
    syncChoropleth(map);
    syncTehsilHighlight(map);
    syncHotspots(map);
    void syncHotspotMarkers(map);
    bindHotspotEvents(map);
  } catch {
    // Map disposed mid-sync — next registration rebuilds from store state.
  }
}

/** Frames the analysed bbox on the map, keeping the strip visible. */
function fitToBbox(
  bbox: [number, number, number, number],
  options: { maxZoom?: number; padding?: number } = {},
): void {
  const map = mainMap;
  if (!map) return;
  const app = useAppStore.getState();
  const desktop = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
  const strip = desktop && app.resultsOpen && (app.searching || app.hasSearched) ? app.stripHeightPx : 0;
  map.fitBounds(bboxToBounds(bbox), {
    padding: {
      top: options.padding ?? 64,
      right: options.padding ?? 64,
      left: options.padding ?? 64,
      bottom: (options.padding ?? 64) + strip,
    },
    duration: 600,
    maxZoom: options.maxZoom ?? 12,
  });
}

/**
 * Entry point from MapCanvas.addAppLayers(): rebuilds every compare source
 * and layer for the freshly loaded style from the current store state.
 * `style.load` can fire before the style reports fully loaded — in that case
 * the sync is deferred to the next `idle`, which is guaranteed to follow.
 */
export function addCompareLayers(map: MapLibreMap): void {
  requestSync(map);
}

/** At most one deferred sync per map until its style settles. */
const pendingSync = new WeakSet<MapLibreMap>();

/**
 * Full compare sync now, or on the next `idle` when the style is momentarily
 * settling (glyphs/sprite in flight). Without the deferred path a tab/theme
 * change during a busy style would silently leave stale layer visibility.
 */
function requestSync(map: MapLibreMap): void {
  if (map.isStyleLoaded()) {
    syncCompareMap(map);
    return;
  }
  if (pendingSync.has(map)) return;
  pendingSync.add(map);
  map.once("idle", () => {
    pendingSync.delete(map);
    syncCompareMap(map);
  });
}

/**
 * Entering the Swipe tab: hide every main-map compare layer immediately —
 * pure layout operations that are safe even while the style settles, so the
 * overlay/hotspots never linger behind the swipe maps (the full sync may
 * defer to idle). No-op on other tabs; the regular sync owns those states.
 */
export function syncTabVisibility(): void {
  const map = mainMap;
  if (!map) return;
  try {
    const state = useCompareStore.getState();
    if (!state.result || state.tab !== "swipe") return;
    const hide = (layerId: string): void => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
    };
    hide(LAYER.overlay);
    hide(LAYER.choropleth);
    hide(LAYER.hotspotFill);
    hide(LAYER.hotspotLine);
    hide(LAYER.hotspotHover);
  } catch {
    // Map disposed mid-sync.
  }
}

export function registerMainMap(map: MapLibreMap): void {
  mainMap = map;
  setDebugMap("main", map);
  requestSync(map);
}

export function unregisterMainMap(map: MapLibreMap): void {
  if (mainMap === map) {
    setDebugMap("main", null);
    mainMap = null;
  }
  hotspotPopup?.remove();
  hotspotPopup = null;
  removeHotspotMarkers();
}

export function getMainMap(): MapLibreMap | null {
  return mainMap;
}

/**
 * Swaps the overlay image (recoloured blob URL after class toggles or the
 * boost filter, or the original server PNG). Module state keeps the URL
 * across style reloads.
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

/** Hotspot list/map click → select it, frame its patch and open the popup. */
export function focusHotspot(rank: number, bbox: [number, number, number, number]): void {
  useCompareStore.getState().setSelectedHotspot(rank);
  fitToBbox(bbox, { maxZoom: 14, padding: 80 });
  void openHotspotPopup(rank);
}

/** "Zoom to changes" — frames the union of every detected change pixel. */
export function focusChangeBbox(): void {
  const bbox = useCompareStore.getState().result?.stats.changeBbox;
  if (!bbox) return;
  fitToBbox(bbox, { maxZoom: 13, padding: 80 });
}

/** Tehsil stats row click → frame that tehsil (highlight is store-driven). */
export function focusTehsil(id: string): void {
  const map = mainMap;
  if (!map) return;
  const source = map.getSource(TEHSIL_SRC) as GeoJSONSource | undefined;
  const data = source?.getData() as GeoJSON.FeatureCollection | undefined;
  const feature = data?.features.find((candidate) => String(candidate.properties?.id) === id);
  const geometry = feature?.geometry;
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) return;
  const bbox = bboxFromGeometry(geometry as ClipGeometry);
  if (!bbox) return;
  fitToBbox(bbox, { maxZoom: 12, padding: 72 });
}

// Drive the registered map from store changes (result, tab, hover, theme, …).
useCompareStore.subscribe((state, previous) => {
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
    fittedResultKey = null;
  }
  if (
    state.result &&
    state.result.key !== previous.result?.key &&
    state.result.key !== fittedResultKey
  ) {
    fittedResultKey = state.result.key;
    fitToBbox(state.result.bbox);
  }
  if (mainMap) requestSync(mainMap);
});

// Theme flips the outline/marker colours of the compare display layers.
useTheme.subscribe(() => {
  if (mainMap) requestSync(mainMap);
});
