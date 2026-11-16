import { create } from "zustand";
import type { BBox } from "@/lib/data";
import type { FieldsYear } from "@/lib/fields/query";
import type { PatternClass } from "@/lib/fields/config";
import type { FieldsColorBy, FieldsRenderMode } from "@/lib/fields/style";
import type { FieldScope } from "@/lib/fields/summary";
import {
  FieldsClientError,
  fetchFields,
  streamPattern,
  type FieldsResponse,
  type PatternClientResult,
  type PatternStage,
} from "@/lib/fields/client";
import { registerHomeResetHook } from "@/lib/homeReset";

/**
 * Fields & cropping-pattern demo state (Phase 3). The panel drives loads and
 * the pattern run; the map bridge subscribes to the same store for boundary
 * and class-fill layers. Selection is always a viewport bbox (≤ FIELDS_MAX_KM2)
 * — admin areas are far too large for the 12-render PU budget.
 *
 * Phase 2 view state lives here too: colour-by mode, fill/outline render mode
 * and the legend class filter (empty = show everything).
 */

export interface FieldsError {
  code: string;
  message: string;
}

/** Scope the current fields were loaded for (caption under the card). */
export interface FieldsLoadedScope {
  scope: FieldScope;
  name: string | null;
}

export interface FieldsState {
  visible: boolean;
  year: FieldsYear;
  minConfidence: number;
  grouping: boolean;
  colorBy: FieldsColorBy;
  renderMode: FieldsRenderMode;
  /** Active legend class filter; empty = every class visible. */
  filterClasses: PatternClass[];
  /** Which selection the next "Load fields" uses. */
  scope: FieldScope;
  /** What the current fields came from (set on a successful load). */
  loadedScope: FieldsLoadedScope | null;

  loading: boolean;
  error: FieldsError | null;
  /** Bbox of the last successful fields load (pattern runs reuse it). */
  bbox: BBox | null;
  selectedAreaKm2: number | null;
  confidenceAvailable: boolean;
  count: number;
  truncated: boolean;
  totalAreaM2: number;
  fields: FieldsResponse["fields"] | null;

  patternRunning: boolean;
  patternStage: PatternStage | null;
  /** Months reported so far (0..12) during a live run. */
  patternMonthsDone: number;
  patternError: FieldsError | null;
  pattern: PatternClientResult | null;

  selectedFieldId: string | null;

  setYear: (year: FieldsYear) => void;
  setMinConfidence: (value: number) => void;
  setGrouping: (value: boolean) => void;
  setColorBy: (value: FieldsColorBy) => void;
  setRenderMode: (value: FieldsRenderMode) => void;
  setScope: (value: FieldScope) => void;
  /** Chip toggle: first click isolates a class, later clicks add/remove. */
  toggleClassFilter: (cls: PatternClass) => void;
  /** Chip "Only": show exactly this class. */
  onlyClassFilter: (cls: PatternClass) => void;
  /** Legend "Show all": clear the filter. */
  clearClassFilter: () => void;
  toggleVisible: () => void;
  selectField: (id: string | null) => void;
  clearError: () => void;
  clearPattern: () => void;
  loadFields: (bbox: BBox, loadedScope?: FieldsLoadedScope) => Promise<void>;
  runPattern: () => Promise<void>;
}

function toError(error: unknown): FieldsError {
  if (error instanceof FieldsClientError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.message) return { code: "UNKNOWN", message: error.message };
  return { code: "UNKNOWN", message: "Unexpected failure. Try again shortly." };
}

/** Bumped by the home reset so late field/pattern responses are discarded. */
let fieldsEpoch = 0;

export const useFieldsStore = create<FieldsState>((set, get) => ({
  visible: true,
  year: 2025,
  minConfidence: 69,
  grouping: false,
  colorBy: "pattern",
  renderMode: "fill",
  filterClasses: [],
  scope: "viewport",
  loadedScope: null,

  loading: false,
  error: null,
  bbox: null,
  selectedAreaKm2: null,
  confidenceAvailable: false,
  count: 0,
  truncated: false,
  totalAreaM2: 0,
  fields: null,

  patternRunning: false,
  patternStage: null,
  patternMonthsDone: 0,
  patternError: null,
  pattern: null,

  selectedFieldId: null,

  setYear: (year) => set({ year }),
  setMinConfidence: (minConfidence) => set({ minConfidence }),
  setGrouping: (grouping) => set({ grouping }),
  setColorBy: (colorBy) => set({ colorBy }),
  setRenderMode: (renderMode) => set({ renderMode }),
  setScope: (scope) => set({ scope }),
  toggleClassFilter: (cls) =>
    set((s) => {
      if (s.filterClasses.length === 0) return { filterClasses: [cls] };
      const has = s.filterClasses.includes(cls);
      const next = has
        ? s.filterClasses.filter((entry) => entry !== cls)
        : [...s.filterClasses, cls];
      // Removing the last visible class would mute everything — clear instead.
      return { filterClasses: next.length === 0 ? [] : next };
    }),
  onlyClassFilter: (cls) => set({ filterClasses: [cls] }),
  clearClassFilter: () => set({ filterClasses: [] }),
  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  selectField: (selectedFieldId) => set({ selectedFieldId }),
  clearError: () => set({ error: null }),
  clearPattern: () =>
    set({
      pattern: null,
      patternError: null,
      patternStage: null,
      patternMonthsDone: 0,
      selectedFieldId: null,
      filterClasses: [],
    }),

  loadFields: async (bbox, loadedScope) => {
    if (get().loading) return;
    const { year, minConfidence } = get();
    const epoch = fieldsEpoch;
    set({
      loading: true,
      error: null,
      patternError: null,
      // New selection invalidates any previous pattern run.
      pattern: null,
      patternStage: null,
      patternMonthsDone: 0,
      selectedFieldId: null,
      filterClasses: [],
      loadedScope: loadedScope ?? { scope: "viewport", name: null },
    });
    try {
      const result = await fetchFields({ bbox, year, minConfidence });
      if (epoch !== fieldsEpoch) return; // superseded by a home reset
      set({
        loading: false,
        bbox: result.bbox,
        selectedAreaKm2: result.selectedAreaKm2,
        confidenceAvailable: result.confidenceAvailable,
        count: result.count,
        truncated: result.truncated,
        totalAreaM2: result.totalAreaM2,
        fields: result.fields,
        minConfidence: result.minConfidence,
        visible: true,
      });
    } catch (error) {
      if (epoch !== fieldsEpoch) return;
      set({
        loading: false,
        error: toError(error),
        fields: null,
        bbox: null,
        selectedAreaKm2: null,
        confidenceAvailable: false,
        count: 0,
        truncated: false,
        totalAreaM2: 0,
        pattern: null,
        patternStage: null,
        patternMonthsDone: 0,
        selectedFieldId: null,
        loadedScope: null,
      });
    }
  },

  runPattern: async () => {
    const state = get();
    if (state.patternRunning || !state.bbox || !state.fields) return;
    const epoch = fieldsEpoch;
    set({
      patternRunning: true,
      patternError: null,
      pattern: null,
      patternStage: "fields",
      patternMonthsDone: 0,
      selectedFieldId: null,
      filterClasses: [],
    });
    try {
      const result = await streamPattern(
        {
          bbox: state.bbox,
          year: state.year,
          minConfidence: state.minConfidence,
          grouping: state.grouping,
        },
        {
          onStage: (stage) => {
            if (epoch === fieldsEpoch) set({ patternStage: stage });
          },
          onMonth: () => {
            if (epoch !== fieldsEpoch) return;
            set((s) => ({ patternMonthsDone: Math.min(12, s.patternMonthsDone + 1) }));
          },
        },
      );
      if (epoch !== fieldsEpoch) return;
      set({
        patternRunning: false,
        patternStage: null,
        pattern: result,
        patternMonthsDone: 12,
      });
    } catch (error) {
      if (epoch !== fieldsEpoch) return;
      set({
        patternRunning: false,
        patternStage: null,
        patternError: toError(error),
      });
    }
  },
}));

/**
 * Home reset: drop the loaded fields and any pattern run (the selection they
 * belong to is gone). View settings — visibility, year, confidence, grouping
 * — are kept; they are not part of the area selection.
 */
registerHomeResetHook(() => {
  fieldsEpoch += 1;
  useFieldsStore.setState({
    loading: false,
    error: null,
    bbox: null,
    selectedAreaKm2: null,
    confidenceAvailable: false,
    count: 0,
    truncated: false,
    totalAreaM2: 0,
    fields: null,
    patternRunning: false,
    patternStage: null,
    patternMonthsDone: 0,
    patternError: null,
    pattern: null,
    selectedFieldId: null,
    filterClasses: [],
    loadedScope: null,
  });
});

/** Pattern field rows keyed by feature id (map fill + panel list). */
export function patternById(
  pattern: PatternClientResult | null,
): Map<string, PatternClientResult["fields"][number]> {
  const map = new Map<string, PatternClientResult["fields"][number]>();
  if (!pattern) return map;
  for (const field of pattern.fields) map.set(field.id, field);
  return map;
}
