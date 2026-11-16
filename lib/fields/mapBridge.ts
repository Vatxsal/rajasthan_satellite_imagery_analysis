import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { EMPTY_FEATURE_COLLECTION } from "@/lib/map/geojson";
import { FIELDS_LAYERS } from "@/lib/map/constants";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { FIELDS_BOUNDARY_COLOR, patternClassLabel } from "@/lib/fields/colors";
import {
  FILL_OPACITY,
  colorByExpression,
  fillLayerVisibility,
  fieldsFillOpacityExpression,
  fieldsLineOpacityExpression,
  fieldsLineWidthExpression,
} from "@/lib/fields/style";
import { patternById, useFieldsStore } from "@/store/useFieldsStore";
import type { FieldsState } from "@/store/useFieldsStore";

/**
 * Fields demo map layers (Phase 3): parcel outlines over the basemap, with a
 * translucent class fill once a pattern result exists. Rebuilt on every
 * style.load via MapCanvas.addAppLayers; live store updates flow through
 * syncFieldsMap (FieldsMapController).
 *
 * Phase 2: colour-by (pattern / group / confidence), 18 % base wash inside
 * the 15–25 % spec band, legend class filtering (ghosted instead of hidden),
 * feature-state hover / selection / flash emphasis, fill-vs-outline render
 * mode, and row-hover / row-fly helpers the panel drives.
 *
 * Anchors: fill sits just below admin boundary lines (parcels stay readable
 * under district/tehsil rules), line sits just above the fill.
 */

const SRC = {
  fields: "fields-boundaries",
} as const;

const LAYER = {
  fill: FIELDS_LAYERS.fill,
  line: FIELDS_LAYERS.line,
} as const;

/** Feature-state keys written by bindFieldsInteractions / the panel helpers. */
const STATE = {
  hover: "hover",
  selected: "selected",
  flash: "flash",
} as const;

/** Joins pattern class/group onto the boundary FeatureCollection for the map. */
export function buildFieldsGeoJson(state: Pick<FieldsState, "fields" | "pattern">): GeoJSON.FeatureCollection {
  if (!state.fields) return EMPTY_FEATURE_COLLECTION;
  const byId = patternById(state.pattern);
  if (byId.size === 0) {
    return state.fields as GeoJSON.FeatureCollection;
  }
  return {
    type: "FeatureCollection",
    features: state.fields.features.map((feature) => {
      const id = typeof feature.id === "string" ? feature.id : String(feature.id ?? "");
      const row = byId.get(id);
      return {
        ...feature,
        properties: {
          ...feature.properties,
          cls: row?.cls ?? "unclassified",
          group: row?.group ?? null,
        },
      };
    }),
  };
}

function firstLabelAnchor(map: MapLibreMap): string | undefined {
  const layers = map.getStyle().layers ?? [];
  return layers.find((layer) => layer.type === "symbol")?.id;
}

/**
 * Creates the fields source + layers for a freshly loaded style and applies
 * the current store state. Idempotent per style (early-return if the source
 * already exists — addAppLayers re-runs on every style.load).
 */
export function addFieldsLayers(map: MapLibreMap): void {
  if (map.getSource(SRC.fields)) {
    syncFieldsMap(map);
    return;
  }

  map.addSource(SRC.fields, {
    type: "geojson",
    data: EMPTY_FEATURE_COLLECTION,
    promoteId: "id",
  });
  const anchor = firstLabelAnchor(map);

  map.addLayer(
    {
      id: LAYER.fill,
      type: "fill",
      source: SRC.fields,
      paint: {
        "fill-color": FIELDS_BOUNDARY_COLOR,
        "fill-opacity": FILL_OPACITY.plain,
      },
    },
    // Below admin lines so district/tehsil rules stay on top of parcels.
    map.getLayer("districts-line") ? "districts-line" : anchor,
  );

  map.addLayer(
    {
      id: LAYER.line,
      type: "line",
      source: SRC.fields,
      paint: {
        "line-color": FIELDS_BOUNDARY_COLOR,
        "line-width": 1,
        "line-opacity": 0.9,
      },
    },
    map.getLayer("districts-line") ? "districts-line" : anchor,
  );

  syncFieldsMap(map);
}

// ── feature-state helpers (hover / selection / flash) ───────────────────────

function setFeatureStateSafe(
  map: MapLibreMap,
  id: string | number | null | undefined,
  key: string,
  value: boolean,
): void {
  if (typeof id !== "string" && typeof id !== "number") return;
  try {
    map.setFeatureState({ source: SRC.fields, id }, { [key]: value });
  } catch {
    // Map disposed or source recreated mid-flight.
  }
}

/** Last id carrying the `selected` state (single main map). */
let lastSelectedId: string | number | null = null;

function applySelectionState(map: MapLibreMap, id: string | null): void {
  if (lastSelectedId !== null && lastSelectedId !== id) {
    setFeatureStateSafe(map, lastSelectedId, STATE.selected, false);
  }
  lastSelectedId = id;
  if (id !== null) setFeatureStateSafe(map, id, STATE.selected, true);
}

const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Pulses a parcel bright for ~1.5 s (row click / inspector focus). */
export function flashFieldsFeature(map: MapLibreMap, id: string): void {
  const previous = flashTimers.get(id);
  if (previous) clearTimeout(previous);
  setFeatureStateSafe(map, id, STATE.flash, true);
  flashTimers.set(
    id,
    setTimeout(() => {
      setFeatureStateSafe(map, id, STATE.flash, false);
      flashTimers.delete(id);
    }, 1_500),
  );
}

/** Row-hover highlight (panel drives it; null id clears). */
export function setFieldsFeatureHover(
  map: MapLibreMap | null,
  id: string | null,
  on: boolean,
): void {
  if (!map) return;
  setFeatureStateSafe(map, id, STATE.hover, on);
}

/**
 * Flies to a parcel from the loaded collection and flashes it. Returns false
 * when the id is not in the current selection (nothing to fly to).
 */
export function focusFieldsFeature(map: MapLibreMap, id: string): boolean {
  const feature = useFieldsStore
    .getState()
    .fields?.features.find((entry) => String(entry.id) === id);
  if (!feature) return false;
  const bbox = bboxFromGeometry(feature.geometry);
  if (bbox) {
    try {
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 90, duration: 900, maxZoom: 16 },
      );
    } catch {
      // Map disposed mid-flight.
    }
  }
  flashFieldsFeature(map, id);
  return true;
}

const boundMaps = new WeakSet<MapLibreMap>();

/**
 * Pointer emphasis: hovering a parcel (fill or outline) sets its hover
 * feature-state, leaving clears it. Bound once per map instance — the
 * layer-id keyed listeners keep working across style reloads, and the
 * WeakSet stops double registration from repeated syncs.
 */
export function bindFieldsInteractions(map: MapLibreMap): void {
  if (boundMaps.has(map)) return;
  boundMaps.add(map);
  for (const layer of [LAYER.fill, LAYER.line]) {
    map.on("mouseenter", layer, (event) => {
      setFeatureStateSafe(map, event.features?.[0]?.id, STATE.hover, true);
    });
    map.on("mouseleave", layer, (event) => {
      setFeatureStateSafe(map, event.features?.[0]?.id, STATE.hover, false);
    });
  }
}

// ── store → style sync ──────────────────────────────────────────────────────

/**
 * Pushes store → source data, visibility, colour-by paint, legend filter and
 * selection feature-state. The colour expressions all come from
 * lib/fields/style.ts — `match` arms stay correctly nested there (the Phase 2
 * root-cause fix), so this function only assembles mode/fallback choices.
 */
export function syncFieldsMap(map: MapLibreMap): void {
  const source = map.getSource(SRC.fields) as GeoJSONSource | undefined;
  if (!source) return;

  const state = useFieldsStore.getState();
  const hasPattern = Boolean(state.pattern);
  const layersVisible = state.visible && Boolean(state.fields);
  const activeFilter = state.filterClasses.length > 0 ? state.filterClasses : null;
  const fillBase = hasPattern ? FILL_OPACITY.base : FILL_OPACITY.plain;

  source.setData(buildFieldsGeoJson(state));

  const colorExpression = colorByExpression(state.colorBy, {
    hasPattern,
    groupCount: state.pattern?.grouping.k ?? 0,
    confidenceAvailable: state.confidenceAvailable,
  });

  if (map.getLayer(LAYER.fill)) {
    map.setLayoutProperty(
      LAYER.fill,
      "visibility",
      fillLayerVisibility(layersVisible, state.renderMode),
    );
    map.setPaintProperty(LAYER.fill, "fill-color", colorExpression ?? FIELDS_BOUNDARY_COLOR);
    map.setPaintProperty(
      LAYER.fill,
      "fill-opacity",
      fieldsFillOpacityExpression({ base: fillBase, active: activeFilter }),
    );
    applySelectionState(map, state.selectedFieldId);
  }
  if (map.getLayer(LAYER.line)) {
    map.setLayoutProperty(LAYER.line, "visibility", layersVisible ? "visible" : "none");
    // Outlines carry the colour-by too, so outline-only mode still reads.
    map.setPaintProperty(LAYER.line, "line-color", colorExpression ?? FIELDS_BOUNDARY_COLOR);
    map.setPaintProperty(LAYER.line, "line-width", fieldsLineWidthExpression());
    map.setPaintProperty(LAYER.line, "line-opacity", fieldsLineOpacityExpression({ active: activeFilter }));
  }
}

/** Human-readable class label for popups/tooltips (panel reuses the map order). */
export const fieldsClassLabel = patternClassLabel;
