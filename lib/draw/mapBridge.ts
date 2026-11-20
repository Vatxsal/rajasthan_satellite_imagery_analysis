/**
 * Terra Draw ↔ app binding for the Draw & analyze feature.
 *
 * One Terra Draw instance per main map (WeakMap-bound): polygon / rectangle
 * / circle draw modes plus a select mode for editing, wired to a shared
 * undo/redo stack (mode + session + default keyboard shortcuts). Feature
 * events flow into useDrawStore; store actions flow back through the
 * DrawRuntime installed here. Map interactions (pan lock, keyboard focus)
 * follow the active tool so taps always add vertices, never pan.
 */
import {
  TerraDraw,
  TerraDrawCircleMode,
  TerraDrawModeUndoRedo,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawSelectMode,
  TerraDrawSessionUndoRedo,
  TerraDrawUndoRedoKeyboardShortcuts,
  type GeoJSONStoreFeatures,
  type HexColor,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import type { Map as MapLibreMap } from "maplibre-gl";
import { CIRCLE_SEGMENTS, DRAW_DEFAULT_COLOR, DRAW_PALETTE } from "@/lib/draw/constants";
import { setDrawRuntime, useDrawStore, type DrawRuntime } from "@/store/useDrawStore";

/** Terra Draw's maplibre adapter prefixes every layer/source with "td". */
const TD_PREFIX = "td-";
const DRAW_MODE_NAMES = new Set(["polygon", "rectangle", "circle"]);

/**
 * Adapter coordinate precision (decimals). Terra Draw rejects programmatically
 * added features whose coordinates carry more decimals ("excessive
 * precision") — GeoJSON exports routinely have 14+ — so everything entering
 * `draw.addFeatures` is rounded to this cap first.
 */
const COORDINATE_PRECISION = 9;

function limitPrecision(value: number): number {
  const factor = 10 ** COORDINATE_PRECISION;
  return Math.round(value * factor) / factor;
}

function limitGeometryPrecision(geometry: GeoJSON.Polygon): GeoJSON.Polygon {
  return {
    type: "Polygon",
    coordinates: geometry.coordinates.map((ring) =>
      ring.map(([lng, lat]) => [limitPrecision(lng), limitPrecision(lat)]),
    ),
  };
}

interface Binding {
  draw: TerraDraw;
  cleanup: () => void;
}

const bindings = new WeakMap<MapLibreMap, Binding>();
const disposed = new WeakSet<MapLibreMap>();

/* ------------------------------------------------------------- styling */

function nextDrawColor(): HexColor {
  const { colorSeq } = useDrawStore.getState();
  return (DRAW_PALETTE[colorSeq % DRAW_PALETTE.length] ?? DRAW_DEFAULT_COLOR) as HexColor;
}

function featureColor(feature: GeoJSONStoreFeatures): HexColor {
  const own = feature.properties.color;
  if (typeof own === "string" && own.startsWith("#")) return own as HexColor;
  return nextDrawColor();
}

const BASE_STYLES = {
  fillColor: featureColor,
  fillOpacity: 0.18,
  outlineColor: featureColor,
  outlineOpacity: 1,
  outlineWidth: 2,
  coordinatePointWidth: 8,
  coordinatePointColor: "#ffffff",
  coordinatePointOpacity: 1,
  coordinatePointOutlineWidth: 2,
  coordinatePointOutlineColor: "#111827",
  coordinatePointOutlineOpacity: 1,
} as const;

const SELECT_FLAGS = {
  polygon: {
    feature: {
      draggable: true,
      coordinates: { draggable: true, midpoints: { draggable: true }, deletable: true },
    },
  },
  rectangle: {
    feature: {
      draggable: true,
      coordinates: { draggable: true, midpoints: { draggable: true }, deletable: true },
    },
  },
  // A circle's vertices are generated from centre+radius — dragging one
  // would distort it; move the whole shape instead.
  circle: {
    feature: {
      draggable: true,
      coordinates: { draggable: false },
    },
  },
} as const;

/* --------------------------------------------------------- public API */

/**
 * Bind Terra Draw to the map once (idempotent). Safe to call before the
 * style finishes loading — the bind defers to the next style.load, after
 * MapCanvas.addAppLayers has run (listener registration order).
 */
export function bindDrawMap(map: MapLibreMap): void {
  if (bindings.has(map) || disposed.has(map)) return;
  if (!map.isStyleLoaded()) {
    const onReady = (): void => {
      map.off("style.load", onReady);
      if (disposed.has(map)) return;
      bindDrawMap(map);
    };
    map.on("style.load", onReady);
    return;
  }

  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: COORDINATE_PRECISION }),
    modes: [
      new TerraDrawPolygonMode({
        styles: {
          ...BASE_STYLES,
          closingPointWidth: 12,
          closingPointColor: "#ffffff",
          closingPointOpacity: 1,
          closingPointOutlineWidth: 2,
          closingPointOutlineColor: "#111827",
          closingPointOutlineOpacity: 1,
        },
        keyEvents: { cancel: "Escape", finish: "Enter" },
        showCoordinatePoints: true,
      }),
      new TerraDrawRectangleMode({
        styles: BASE_STYLES,
        keyEvents: { cancel: "Escape", finish: "Enter" },
        showCoordinatePoints: true,
      }),
      new TerraDrawCircleMode({
        styles: BASE_STYLES,
        keyEvents: { cancel: "Escape", finish: "Enter" },
        segments: CIRCLE_SEGMENTS,
        showCoordinatePoints: true,
      }),
      new TerraDrawSelectMode({ flags: SELECT_FLAGS }),
    ],
    undoRedo: {
      modeLevel: new TerraDrawModeUndoRedo(),
      sessionLevel: new TerraDrawSessionUndoRedo(),
      keyboardShortcuts: new TerraDrawUndoRedoKeyboardShortcuts(),
    },
  });
  draw.start();

  const initialDragPan = map.dragPan.isEnabled();
  const initialDoubleClickZoom = map.doubleClickZoom.isEnabled();

  const dispatchKey = (key: string): void => {
    try {
      map.getCanvas().dispatchEvent(new KeyboardEvent("keyup", { key }));
    } catch {
      // Map disposed mid-action.
    }
  };

  const refreshHistory = (): void => {
    try {
      useDrawStore.getState().setHistory(draw.canUndo(), draw.canRedo());
    } catch {
      // Instance stopped.
    }
  };

  /** While a shape tool is armed the map must not pan under a stray tap. */
  const applyMapLock = (): void => {
    const tool = useDrawStore.getState().tool;
    const locked = tool === "polygon" || tool === "rectangle" || tool === "circle";
    try {
      if (locked) {
        map.dragPan.disable();
        map.doubleClickZoom.disable();
      } else {
        if (initialDragPan) map.dragPan.enable();
        if (initialDoubleClickZoom) map.doubleClickZoom.enable();
      }
    } catch {
      // Map disposed.
    }
  };

  // The adapter re-enables dragPan when its own drag ends; re-assert the
  // lock on the next tick so a finished rectangle drag doesn't unlock pan.
  let lockTimer: number | null = null;
  const reassertLock = (): void => {
    if (lockTimer !== null) return;
    lockTimer = window.setTimeout(() => {
      lockTimer = null;
      applyMapLock();
    }, 0);
  };

  const syncFromSnapshot = (): void => {
    let snapshot: GeoJSONStoreFeatures[];
    try {
      snapshot = draw.getSnapshot();
    } catch {
      return;
    }
    const committed: {
      id: string;
      geometry: GeoJSON.Polygon;
      name?: string;
      color?: string;
    }[] = [];
    let draftPolygon: GeoJSON.Polygon | null = null;
    let draftLine: GeoJSON.LineString | null = null;
    for (const feature of snapshot) {
      const { geometry, properties } = feature;
      if (feature.id === undefined) continue;
      if (properties.currentlyDrawing === true) {
        // In-progress feature (points carry the flag too — ignore them).
        if (geometry.type === "Polygon" && !draftPolygon) draftPolygon = geometry;
        else if (geometry.type === "LineString" && !draftPolygon && !draftLine) draftLine = geometry;
        continue;
      }
      if (geometry.type !== "Polygon") continue;
      if (!DRAW_MODE_NAMES.has(String(properties.mode))) continue;
      // Imported/saved features carry their own name + colour in properties;
      // hand-drawn ones leave them undefined (the store names them).
      committed.push({
        id: String(feature.id),
        geometry,
        name: typeof properties.name === "string" ? properties.name : undefined,
        color:
          typeof properties.color === "string" && properties.color.startsWith("#")
            ? properties.color
            : undefined,
      });
    }
    const store = useDrawStore.getState();
    store.syncShapes(committed);
    store.updateDraft(draftPolygon ?? draftLine);
    refreshHistory();
  };

  let syncRaf = 0;
  const scheduleSync = (): void => {
    if (syncRaf !== 0) return;
    syncRaf = window.requestAnimationFrame(() => {
      syncRaf = 0;
      syncFromSnapshot();
    });
  };

  draw.on("finish", (id) => {
    try {
      const feature = draw.getSnapshotFeature(id);
      if (feature && feature.geometry.type === "Polygon") {
        // Tag the feature so map clicks can identify it (the adapter sets
        // no promoteId — queryRenderedFeatures has no feature.id to read).
        draw.updateFeatureProperties(id, { shapeId: String(id) });
        useDrawStore.getState().onShapeFinished(String(id), feature.geometry);
      }
    } catch {
      // Feature removed mid-finish.
    }
    scheduleSync();
  });
  draw.on("change", () => {
    scheduleSync();
    reassertLock();
  });
  draw.on("select", (id) => useDrawStore.setState({ activeShapeId: String(id) }));
  draw.on("deselect", () => useDrawStore.setState({ activeShapeId: null }));
  draw.on("history", refreshHistory);

  // Backspace removes the in-progress last vertex; Enter/Esc reach the mode
  // through the canvas when it has focus, otherwise are forwarded here.
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (!useDrawStore.getState().tool) return;
    if (event.key === "Backspace") {
      event.preventDefault();
      if (draw.getModeState() === "drawing") {
        draw.undo();
        refreshHistory();
      }
      return;
    }
    if (event.key === "Enter" || event.key === "Escape") {
      if (draw.getModeState() !== "drawing") return;
      if (document.activeElement === map.getCanvas()) return; // real event flows on
      event.preventDefault();
      dispatchKey(event.key);
    }
  };
  window.addEventListener("keydown", onKeyDown);

  const runtime: DrawRuntime = {
    setTool(tool) {
      try {
        if (draw.getModeState() === "drawing") dispatchKey("Escape");
        draw.setMode(tool ?? "static");
      } catch {
        return;
      }
      applyMapLock();
      refreshHistory();
      if (tool !== null) {
        try {
          map.getCanvas().focus({ preventScroll: true });
        } catch {
          // Canvas gone.
        }
      }
    },
    finishDrawing() {
      if (draw.getModeState() === "drawing") dispatchKey("Enter");
    },
    cancelDrawing() {
      if (draw.getModeState() === "drawing") dispatchKey("Escape");
    },
    undo() {
      try {
        draw.undo();
      } catch {
        // Nothing to undo.
      }
      refreshHistory();
    },
    redo() {
      try {
        draw.redo();
      } catch {
        // Nothing to redo.
      }
      refreshHistory();
    },
    deleteFeature(id) {
      try {
        draw.removeFeatures([id]);
      } catch {
        // Already gone.
      }
      scheduleSync();
    },
    clearAll() {
      try {
        if (draw.getModeState() === "drawing") dispatchKey("Escape");
        const ids = draw
          .getSnapshot()
          .map((feature) => feature.id)
          .filter((id) => id !== undefined) as (string | number)[];
        if (ids.length > 0) draw.removeFeatures(ids);
        draw.clearUndoRedoHistory();
      } catch {
        // Instance stopped.
      }
      refreshHistory();
    },
    select(id) {
      try {
        draw.selectFeature(id);
      } catch {
        // No select mode (never happens — one is always registered).
      }
    },
    deselect(id) {
      // Only deselect while the select mode owns the map: deselectFeature
      // would otherwise switch modes out from under an active draw tool.
      try {
        if (draw.getMode() === "select") draw.deselectFeature(id);
      } catch {
        // Nothing selected.
      }
    },
    setColor(id, color) {
      try {
        draw.updateFeatureProperties(id, { color });
      } catch {
        // Feature gone.
      }
      scheduleSync();
    },
    addFeatures(entries) {
      const added: string[] = [];
      let rejected = 0;
      for (const entry of entries) {
        const id = crypto.randomUUID();
        try {
          const results = draw.addFeatures([
            {
              id,
              type: "Feature",
              geometry: limitGeometryPrecision(entry.geometry),
              properties: {
                mode: "polygon",
                color: entry.color,
                shapeId: id,
                ...(entry.name ? { name: entry.name } : {}),
              },
            },
          ]);
          if (results.some((result) => result.id === id && result.valid)) added.push(id);
          else rejected += 1;
        } catch {
          rejected += 1;
        }
      }
      if (added.length > 0) scheduleSync();
      return { added, rejected };
    },
  };

  bindings.set(map, {
    draw,
    cleanup: () => {
      window.removeEventListener("keydown", onKeyDown);
      if (lockTimer !== null) {
        window.clearTimeout(lockTimer);
        lockTimer = null;
      }
      applyMapLock();
      try {
        draw.stop();
      } catch {
        // Already stopped.
      }
      const g = window as typeof window & { __rieDraw?: unknown };
      delete g.__rieDraw;
    },
  });
  setDrawRuntime(runtime);

  // Dev-only: expose the live instance for browser harnesses (mirrors
  // window.__rieMaps in lib/compare/bridge).
  const g = window as typeof window & {
    __rieDraw?: { getSnapshot: () => GeoJSONStoreFeatures[] };
  };
  g.__rieDraw = { getSnapshot: () => draw.getSnapshot() };

  // Apply the tool the user may already have picked before the map was ready.
  try {
    draw.setMode(useDrawStore.getState().tool ?? "static");
  } catch {
    // Fall through — runtime.setTool will retry on the next interaction.
  }
  applyMapLock();
  refreshHistory();
}

/** Detach from a map that is about to be removed (page teardown). */
export function unbindDrawMap(map: MapLibreMap): void {
  disposed.add(map);
  const binding = bindings.get(map);
  if (!binding) return;
  bindings.delete(map);
  binding.cleanup();
  setDrawRuntime(null);
}

/**
 * Keep Terra Draw layers above the app's own layers. The adapter appends
 * its layers at the end of the style (already on top), but addAppLayers
 * re-appends app layers on every style.load — re-assert after it runs.
 */
export function bringDrawLayersTop(map: MapLibreMap): void {
  try {
    const style = map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.id.startsWith(TD_PREFIX)) map.moveLayer(layer.id);
    }
  } catch {
    // Style not loaded.
  }
}

/** Exposed for tests: whether a map instance is Terra Draw-bound. */
export function isDrawBound(map: MapLibreMap): boolean {
  return bindings.has(map);
}
