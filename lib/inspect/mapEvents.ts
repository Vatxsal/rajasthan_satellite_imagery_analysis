/**
 * Map inspector — one click handler per map instance (Phase 1).
 *
 * Listens for map clicks, suppresses drags (pointer moved > 6 px between
 * down and up is a pan, not a tap), and opens the unified inspector at the
 * click point. Hit priority: change-event polygon > fields parcel > empty
 * spot (see `pickHit`). Map controls, markers and the (retired) popup live
 * as DOM siblings of the canvas, so canvas clicks never include them.
 *
 * Streets mode additionally captures the plain-words basemap description at
 * the click point; satellite mode leaves it empty (the card offers the
 * on-demand Nominatim lookup instead).
 */
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { basemapWordsAt, isDragClick, pickHit } from "@/lib/inspect/hits";
import { EVENT_LAYERS, FIELDS_LAYERS } from "@/lib/map/constants";
import { useAppStore } from "@/store/useAppStore";
import { useDrawStore } from "@/store/useDrawStore";
import { useInspectorStore } from "@/store/useInspectorStore";

/** Maps whose inspector click handler is already bound. */
const inspectorBound = new WeakSet<MapLibreMap>();

function existingLayerIds(map: MapLibreMap, ids: readonly string[]): string[] {
  return ids.filter((id) => map.getLayer(id));
}

/**
 * Binds the inspector's click/drag handling once per map instance.
 * Safe to call from the map-ready effect; survives style reloads (the map
 * object persists across them).
 */
export function bindInspectorMap(map: MapLibreMap): void {
  if (inspectorBound.has(map)) return;
  inspectorBound.add(map);

  let downPoint: { x: number; y: number } | null = null;
  const markDown = (event: { point: { x: number; y: number } }): void => {
    downPoint = { x: event.point.x, y: event.point.y };
  };
  map.on("mousedown", markDown);
  map.on("touchstart", markDown);

  map.on("click", (event: MapMouseEvent) => {
    const wasDrag = isDragClick(downPoint, event.point);
    downPoint = null;
    if (wasDrag) return;
    // The measure tool owns clicks while armed (each click adds a point).
    if (useAppStore.getState().measureActive) return;
    // Any draw tool owns clicks too — drawing, vertex drags and selection
    // all stay with Terra Draw while a tool is armed.
    if (useDrawStore.getState().tool !== null) return;

    // Clicking an existing drawn shape (tool idle) opens its shape card
    // instead of the inspector — the inspector ignores td- layers.
    const tdIds = (map.getStyle().layers ?? [])
      .filter((layer) => layer.id.startsWith("td-"))
      .map((layer) => layer.id);
    if (tdIds.length > 0) {
      const tdFeatures = map.queryRenderedFeatures(event.point, { layers: tdIds });
      const shapeHit = tdFeatures.find(
        (feature) =>
          feature.geometry.type === "Polygon" &&
          typeof feature.properties?.shapeId === "string",
      );
      if (shapeHit) {
        useDrawStore.getState().selectShape(shapeHit.properties.shapeId as string);
        useInspectorStore.getState().close();
        return;
      }
    }

    const eventIds = existingLayerIds(map, Object.values(EVENT_LAYERS));
    const fieldIds = existingLayerIds(map, [FIELDS_LAYERS.fill]);
    const eventFeatures = eventIds.length
      ? map.queryRenderedFeatures(event.point, { layers: eventIds })
      : [];
    const fieldFeatures = fieldIds.length
      ? map.queryRenderedFeatures(event.point, { layers: fieldIds })
      : [];
    const hit = pickHit({ eventFeatures, fieldFeatures });
    const basemapWords =
      useAppStore.getState().basemap === "streets" ? basemapWordsAt(map, event.point) : [];

    useInspectorStore.getState().openAt({
      lng: event.lngLat.lng,
      lat: event.lngLat.lat,
      hit,
      basemapWords,
    });
  });
}
