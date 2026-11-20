/**
 * Draw & analyze state.
 *
 * The store owns shape bookkeeping, validation and the analyze run; the map
 * side lives in lib/draw/mapBridge, which installs an imperative
 * `DrawRuntime` on bind. Store actions call the runtime when present (first
 * tool click before the map is ready just records state — the bridge applies
 * it on bind), and the bridge pushes feature events back through the actions
 * below. One source of truth for the committed-shape list: the Terra Draw
 * snapshot, merged with names/notes/colours this store keeps.
 */
import { create } from "zustand";
import {
  DRAW_DEFAULT_COLOR,
  DRAW_PALETTE,
  type DrawTool,
} from "@/lib/draw/constants";
import {
  loadRajasthanOutline,
  measureDrawGeometry,
  validateDrawGeometry,
  type DrawInvalidReason,
  type DrawMetrics,
  type DrawValidity,
  type RajasthanOutline,
} from "@/lib/draw/geometry";
import {
  ShapeAnalyzeError,
  streamShapeAnalyze,
  type ShapeAnalyzeResult,
  type ShapeAnalyzeStage,
} from "@/lib/draw/analyzeClient";
import {
  listSavedShapes,
  removeSavedShape,
  savedShapeId,
  upsertSavedShape,
  type SaveShapeOutcome,
  type SavedShape,
} from "@/lib/draw/saved";
import { registerHomeResetHook } from "@/lib/homeReset";
import { useAppStore } from "@/store/useAppStore";
import { useInspectorStore } from "@/store/useInspectorStore";
import { usePreferencesStore } from "@/store/usePreferencesStore";

export interface DrawShape {
  /** Terra Draw feature id (string form). */
  id: string;
  geometry: GeoJSON.Polygon;
  name: string;
  note: string;
  color: string;
}

export interface DrawDraft {
  geometry: GeoJSON.Polygon | GeoJSON.LineString | null;
  metrics: DrawMetrics | null;
  validity: DrawValidity;
}

/** One analyze run for one shape (POST /api/shapes/analyze). */
export interface DrawAnalysis {
  shapeId: string;
  stage: ShapeAnalyzeStage | null;
  status: "running" | "done" | "error";
  result: ShapeAnalyzeResult | null;
  error: string | null;
}

/** Summary returned by importGeoJson (shown by the panel). */
export interface DrawImportResult {
  imported: number;
  skipped: { reason: string; count: number }[];
}

/** Imperative map operations installed by lib/draw/mapBridge on bind. */
export interface DrawRuntime {
  setTool(tool: DrawTool | null): void;
  finishDrawing(): void;
  cancelDrawing(): void;
  undo(): void;
  redo(): void;
  deleteFeature(id: string): void;
  clearAll(): void;
  select(id: string): void;
  deselect(id: string): void;
  setColor(id: string, color: string): void;
  /** Add already-validated polygons (import / saved shapes) to the map. */
  addFeatures(
    entries: { geometry: GeoJSON.Polygon; color: string; name?: string }[],
  ): { added: string[]; rejected: number };
}

let runtime: DrawRuntime | null = null;

/** Called by the bridge on bind/unbind; null until a map is ready. */
export function setDrawRuntime(next: DrawRuntime | null): void {
  runtime = next;
}

const EMPTY_DRAFT: DrawDraft = {
  geometry: null,
  metrics: null,
  validity: { ok: false, kind: "pending", reason: "structure", message: "Tap the map to start." },
};

interface DrawState {
  /** Active tool; null = draw system idle (shapes stay on the map). */
  tool: DrawTool | null;
  draft: DrawDraft;
  shapes: DrawShape[];
  /** Shape whose card is open (from finishing it or clicking it). */
  activeShapeId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  rajasthan: RajasthanOutline | null;
  /** Palette rotation for the next finished shape. */
  colorSeq: number;
  /** Latest analyze run (shown by the shape card of `analysis.shapeId`). */
  analysis: DrawAnalysis | null;
  /** Browser-local saved shapes for the active subject (Phase 4). */
  savedShapes: SavedShape[];

  setTool(tool: DrawTool | null): void;
  updateDraft(geometry: GeoJSON.Polygon | GeoJSON.LineString | null): void;
  /** Re-run validation after the Rajasthan outline arrives. */
  revalidate(): void;
  ensureRajasthan(): void;
  onShapeFinished(id: string, geometry: GeoJSON.Polygon): void;
  /** Replace the committed list from the map snapshot (keeps names/colours). */
  syncShapes(
    shapes: { id: string; geometry: GeoJSON.Polygon; name?: string; color?: string }[],
  ): void;
  selectShape(id: string): void;
  setActiveShape(id: string | null): void;
  closeCard(): void;
  setShapeField(id: string, patch: Partial<Pick<DrawShape, "name" | "note" | "color">>): void;
  requestDelete(id: string): void;
  requestClear(): void;
  requestUndo(): void;
  requestRedo(): void;
  requestFinish(): void;
  requestCancel(): void;
  setHistory(canUndo: boolean, canRedo: boolean): void;
  /** Streams stats for a committed shape (single run at a time). */
  runAnalysis(shapeId: string): Promise<void>;
  clearAnalysis(): void;
  /** Re-read saved shapes for the current subject (login/logout/import). */
  refreshSavedShapes(): void;
  /** Save (or refresh) the shape in the card; "full" at the 50-item cap. */
  upsertCurrentShape(id: string): SaveShapeOutcome;
  removeSavedShapeById(id: string): void;
  /** Put a saved shape on the map and open its card (selects the existing copy when the content is already there). */
  loadSavedShape(savedId: string): boolean;
  /** Parse a GeoJSON file and add every polygon that passes the draw rules. */
  importGeoJson(text: string): Promise<DrawImportResult>;
  reset(): void;
}

function nextColorFor(index: number): string {
  return DRAW_PALETTE[index % DRAW_PALETTE.length] ?? DRAW_DEFAULT_COLOR;
}

/** "Shape N" where N = highest existing number + 1 (restarts when emptied). */
function nextShapeName(shapes: DrawShape[]): string {
  let max = 0;
  for (const shape of shapes) {
    const match = /^Shape (\d+)$/.exec(shape.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Shape ${max + 1}`;
}

/** Spec-order failure → the short label the import summary shows. */
function importReason(reason: DrawInvalidReason): string {
  switch (reason) {
    case "structure":
      return "unsupported shape";
    case "area":
      return "over 100 km²";
    case "bbox":
      return "bounding box over 25 km";
    case "vertices":
      return "over 500 points";
    case "self-intersection":
      return "self-intersecting";
    case "outside-rajasthan":
      return "outside Rajasthan";
  }
}

let rajasthanRequested = false;

export const useDrawStore = create<DrawState>((set, get) => ({
  tool: null,
  draft: EMPTY_DRAFT,
  shapes: [],
  activeShapeId: null,
  canUndo: false,
  canRedo: false,
  rajasthan: null,
  colorSeq: 0,
  analysis: null,
  savedShapes: [],

  setTool: (tool) => {
    if (tool !== null) get().ensureRajasthan();
    // Arming draw disarms the measure tool (and MeasurePanel disarms draw
    // when it arms measure) — one click handler owns the map at a time.
    if (tool !== null && useAppStore.getState().measureActive) {
      useAppStore.setState({ measureActive: false });
    }
    // The inspector card floats over the map — it would sit exactly where
    // the user is about to draw and swallow taps (same mutual-exclusion
    // rule as the shape card opening).
    if (tool !== null) {
      const inspector = useInspectorStore.getState();
      if (inspector.open) inspector.close();
    }
    if (tool === null) {
      runtime?.setTool(null);
      // Leaving a draw tool drops the in-progress draft and its card; an
      // already-idle selection (map click → shape card) stays as it is.
      set((s) => ({
        tool: null,
        draft: s.tool === null ? s.draft : EMPTY_DRAFT,
        activeShapeId: s.tool === null ? s.activeShapeId : null,
      }));
      return;
    }
    runtime?.setTool(tool);
    set({ tool });
  },

  updateDraft: (geometry) => {
    set({
      draft: {
        geometry,
        metrics: measureDrawGeometry(geometry),
        validity: validateDrawGeometry(geometry, get().rajasthan),
      },
    });
  },

  revalidate: () => {
    const { draft, rajasthan } = get();
    if (!draft.geometry) return;
    set({
      draft: { ...draft, validity: validateDrawGeometry(draft.geometry, rajasthan) },
    });
  },

  ensureRajasthan: () => {
    if (rajasthanRequested) return;
    rajasthanRequested = true;
    void loadRajasthanOutline().then((outline) => {
      if (outline) set({ rajasthan: outline });
      get().revalidate();
    });
  },

  onShapeFinished: (id, geometry) => {
    const state = get();
    if (state.shapes.some((shape) => shape.id === id)) {
      set({ draft: EMPTY_DRAFT, activeShapeId: id });
      return;
    }
    const shape: DrawShape = {
      id,
      geometry,
      name: nextShapeName(state.shapes),
      note: "",
      color: nextColorFor(state.colorSeq),
    };
    set({
      shapes: [...state.shapes, shape],
      colorSeq: state.colorSeq + 1,
      draft: EMPTY_DRAFT,
      activeShapeId: id,
    });
  },

  syncShapes: (list) => {
    const state = get();
    const byId = new Map(state.shapes.map((shape) => [shape.id, shape]));
    let colorSeq = state.colorSeq;
    const shapes: DrawShape[] = [];
    for (const { id, geometry, name, color } of list) {
      const existing = byId.get(id);
      if (existing) {
        shapes.push({ ...existing, geometry });
        continue;
      }
      shapes.push({
        id,
        geometry,
        name: name?.trim() || nextShapeName(shapes),
        note: "",
        color: color ?? nextColorFor(colorSeq),
      });
      colorSeq += 1;
    }
    const activeShapeId =
      state.activeShapeId && shapes.some((shape) => shape.id === state.activeShapeId)
        ? state.activeShapeId
        : null;
    set({ shapes, colorSeq, activeShapeId });
  },

  selectShape: (id) => {
    // Selecting from the panel list while a draw tool is armed must first
    // leave draw mode — otherwise the map would keep adding vertices.
    const { tool } = get();
    if (tool !== null && tool !== "select") get().setTool("select");
    runtime?.select(id);
    set({ activeShapeId: id });
  },

  setActiveShape: (id) => set({ activeShapeId: id }),

  closeCard: () => {
    const { activeShapeId, tool } = get();
    if (activeShapeId && tool === "select") runtime?.deselect(activeShapeId);
    set({ activeShapeId: null });
  },

  setShapeField: (id, patch) => {
    set((state) => ({
      shapes: state.shapes.map((shape) => (shape.id === id ? { ...shape, ...patch } : shape)),
    }));
    if (patch.color) runtime?.setColor(id, patch.color);
  },

  requestDelete: (id) => {
    runtime?.deleteFeature(id);
    set((state) => ({
      shapes: state.shapes.filter((shape) => shape.id !== id),
      activeShapeId: state.activeShapeId === id ? null : state.activeShapeId,
      analysis: state.analysis?.shapeId === id ? null : state.analysis,
    }));
  },

  requestClear: () => {
    runtime?.clearAll();
    set({
      shapes: [],
      activeShapeId: null,
      draft: EMPTY_DRAFT,
      canUndo: false,
      canRedo: false,
      colorSeq: 0,
      analysis: null,
    });
  },

  requestUndo: () => runtime?.undo(),
  requestRedo: () => runtime?.redo(),
  requestFinish: () => runtime?.finishDrawing(),
  requestCancel: () => runtime?.cancelDrawing(),

  setHistory: (canUndo, canRedo) => set({ canUndo, canRedo }),

  runAnalysis: async (shapeId) => {
    const state = get();
    if (state.analysis?.status === "running") return;
    const shape = state.shapes.find((item) => item.id === shapeId);
    if (!shape) return;
    const app = useAppStore.getState();

    set({
      analysis: { shapeId, stage: null, status: "running", result: null, error: null },
    });
    try {
      const result = await streamShapeAnalyze(
        {
          area: { kind: "shape", geometry: shape.geometry, name: shape.name },
          fromDate: app.fromDate,
          toDate: app.toDate,
        },
        {
          onStage: (stage) => {
            const current = get().analysis;
            if (current && current.shapeId === shapeId) set({ analysis: { ...current, stage } });
          },
        },
      );
      const current = get().analysis;
      if (!current || current.shapeId !== shapeId) return; // deleted/cleared mid-run
      set({ analysis: { ...current, status: "done", stage: null, result, error: null } });
    } catch (error) {
      const current = get().analysis;
      if (!current || current.shapeId !== shapeId) return;
      const message =
        error instanceof ShapeAnalyzeError
          ? error.message
          : "Analysis failed. Try again shortly.";
      set({ analysis: { ...current, status: "error", error: message } });
    }
  },

  clearAnalysis: () => set({ analysis: null }),

  refreshSavedShapes: () =>
    set({ savedShapes: listSavedShapes(usePreferencesStore.getState().subject) }),

  upsertCurrentShape: (id) => {
    const shape = get().shapes.find((item) => item.id === id);
    if (!shape) return "invalid";
    const { outcome, shapes } = upsertSavedShape(usePreferencesStore.getState().subject, {
      id: savedShapeId(shape.geometry),
      name: shape.name.slice(0, 80),
      note: shape.note.slice(0, 500),
      color: shape.color,
      geometry: shape.geometry,
    });
    if (outcome === "saved") set({ savedShapes: shapes });
    return outcome;
  },

  removeSavedShapeById: (id) => {
    const subject = usePreferencesStore.getState().subject;
    set({ savedShapes: removeSavedShape(subject, id) });
  },

  loadSavedShape: (savedId) => {
    const state = get();
    const record = state.savedShapes.find((item) => item.id === savedId);
    if (!record || !runtime) return false;
    const geometry = record.geometry as GeoJSON.Polygon;
    // Same content already on the map → open that shape instead of duplicating.
    const existing = state.shapes.find((shape) => savedShapeId(shape.geometry) === savedId);
    if (existing) {
      state.selectShape(existing.id);
      return true;
    }
    const { added } = runtime.addFeatures([
      { geometry, color: record.color, name: record.name },
    ]);
    if (added.length === 0) return false;
    state.selectShape(added[0]!);
    return true;
  },

  importGeoJson: async (text) => {
    const skipped = new Map<string, number>();
    const skip = (reason: string): void => {
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    };
    const finish = (imported: number): DrawImportResult => ({
      imported,
      skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
    });

    if (text.length > 512_000) {
      skip("file too large");
      return finish(0);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      skip("not valid JSON");
      return finish(0);
    }

    const collected: { geometry: GeoJSON.Polygon; name?: string }[] = [];
    const collect = (value: unknown, fallbackName?: string): void => {
      if (!value || typeof value !== "object") return;
      const obj = value as {
        type?: string;
        geometry?: unknown;
        properties?: { name?: unknown };
        coordinates?: unknown;
        features?: unknown[];
      };
      if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
        for (const feature of obj.features) collect(feature);
        return;
      }
      if (obj.type === "Feature") {
        const name =
          typeof obj.properties?.name === "string" && obj.properties.name.trim()
            ? obj.properties.name.trim().slice(0, 80)
            : fallbackName;
        collect(obj.geometry, name);
        return;
      }
      if (obj.type === "MultiPolygon" && Array.isArray(obj.coordinates)) {
        for (const part of obj.coordinates) {
          collect({ type: "Polygon", coordinates: part }, fallbackName);
        }
        return;
      }
      if (obj.type === "Polygon" && Array.isArray(obj.coordinates)) {
        collected.push({
          geometry: { type: "Polygon", coordinates: obj.coordinates } as GeoJSON.Polygon,
          name: fallbackName,
        });
      }
      // Points/lines/others: ignored (a GeoJSON file may legitimately
      // carry context layers we don't draw).
    };
    collect(parsed);
    if (collected.length === 0) {
      skip("no polygons found");
      return finish(0);
    }
    if (collected.length > 100) {
      skip("more than 100 shapes");
      return finish(0);
    }

    // Same cached outline the draw tools use; validate against the freshest copy.
    const outline = await loadRajasthanOutline();
    if (outline && !get().rajasthan) set({ rajasthan: outline });
    const raj = get().rajasthan ?? outline;

    const entries: { geometry: GeoJSON.Polygon; color: string; name?: string }[] = [];
    let colorSeq = get().colorSeq;
    for (const item of collected) {
      const validity = validateDrawGeometry(item.geometry, raj);
      if (!validity.ok) {
        skip(importReason(validity.reason));
        continue;
      }
      entries.push({
        geometry: item.geometry,
        color: nextColorFor(colorSeq),
        name: item.name,
      });
      colorSeq += 1;
    }
    if (entries.length === 0) return finish(0);

    const result = runtime?.addFeatures(entries) ?? { added: [], rejected: entries.length };
    for (let i = 0; i < result.rejected; i++) skip("rejected by the map");
    return finish(result.added.length);
  },

  reset: () => {
    rajasthanRequested = false;
    runtime?.setTool(null);
    runtime?.clearAll();
    set({
      tool: null,
      draft: EMPTY_DRAFT,
      shapes: [],
      activeShapeId: null,
      canUndo: false,
      canRedo: false,
      rajasthan: null,
      colorSeq: 0,
      analysis: null,
    });
  },
}));

registerHomeResetHook(() => useDrawStore.getState().reset());
