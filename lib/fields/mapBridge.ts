import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { EMPTY_FEATURE_COLLECTION } from "@/lib/map/geojson";
import {
  FIELDS_BOUNDARY_COLOR,
  PATTERN_CLASS_COLORS,
  patternClassLabel,
} from "@/lib/fields/colors";
import { PATTERN_CLASSES } from "@/lib/fields/config";
import { patternById, useFieldsStore } from "@/store/useFieldsStore";
import type { FieldsState } from "@/store/useFieldsStore";

/**
 * Fields demo map layers (Phase 3): parcel outlines over the basemap, with a
 * translucent class fill once a pattern result exists. Rebuilt on every
 * style.load via MapCanvas.addAppLayers; live store updates flow through
 * syncFieldsMap (FieldsMapController).
 *
 * Anchors: fill sits just below admin boundary lines (parcels stay readable
 * under district/tehsil rules), line sits just above the fill.
 */

const SRC = {
  fields: "fields-boundaries",
} as const;

const LAYER = {
  fill: "fields-fill",
  line: "fields-line",
} as const;

/** MapLibre match arms: cls → hex, default unclassified grey. */
function classFillExpression(): ExpressionSpecification {
  const arms: unknown[] = ["get", "cls"];
  for (const cls of PATTERN_CLASSES) {
    arms.push(cls, PATTERN_CLASS_COLORS[cls]);
  }
  return ["match", ...arms, PATTERN_CLASS_COLORS.unclassified] as ExpressionSpecification;
}

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

  map.addSource(SRC.fields, { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  const anchor = firstLabelAnchor(map);

  map.addLayer(
    {
      id: LAYER.fill,
      type: "fill",
      source: SRC.fields,
      paint: {
        "fill-color": FIELDS_BOUNDARY_COLOR,
        "fill-opacity": 0.12,
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

/** Pushes store → source data, visibility, and class-fill paint. */
export function syncFieldsMap(map: MapLibreMap): void {
  const source = map.getSource(SRC.fields) as GeoJSONSource | undefined;
  if (!source) return;

  const state = useFieldsStore.getState();
  const hasPattern = Boolean(state.pattern);
  const visible = state.visible && Boolean(state.fields);

  source.setData(buildFieldsGeoJson(state));

  if (map.getLayer(LAYER.fill)) {
    map.setLayoutProperty(LAYER.fill, "visibility", visible ? "visible" : "none");
    map.setPaintProperty(LAYER.fill, "fill-color", hasPattern ? classFillExpression() : FIELDS_BOUNDARY_COLOR);
    map.setPaintProperty(LAYER.fill, "fill-opacity", hasPattern ? 0.35 : 0.12);
  }
  if (map.getLayer(LAYER.line)) {
    map.setLayoutProperty(LAYER.line, "visibility", visible ? "visible" : "none");
    // With a pattern result, parcel outlines use each class colour for contrast.
    map.setPaintProperty(
      LAYER.line,
      "line-color",
      hasPattern ? classFillExpression() : FIELDS_BOUNDARY_COLOR,
    );
    map.setPaintProperty(LAYER.line, "line-width", state.selectedFieldId ? 1.25 : 1);
  }
}

/** Human-readable class label for popups/tooltips (panel reuses the map order). */
export const fieldsClassLabel = patternClassLabel;
