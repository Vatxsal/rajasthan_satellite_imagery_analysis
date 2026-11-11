import { create } from "zustand";
import type { BBox } from "@/lib/data";
import type { FieldsYear } from "@/lib/fields/query";
import {
  FieldsClientError,
  fetchFields,
  streamPattern,
  type FieldsResponse,
  type PatternClientResult,
  type PatternStage,
} from "@/lib/fields/client";

/**
 * Fields & cropping-pattern demo state (Phase 3). The panel drives loads and
 * the pattern run; the map bridge subscribes to the same store for boundary
 * and class-fill layers. Selection is always a viewport bbox (≤ FIELDS_MAX_KM2)
 * — admin areas are far too large for the 12-render PU budget.
 */

export interface FieldsError {
  code: string;
  message: string;
}

export interface FieldsState {
  visible: boolean;
  year: FieldsYear;
  minConfidence: number;
  grouping: boolean;

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
  toggleVisible: () => void;
  selectField: (id: string | null) => void;
  clearError: () => void;
  clearPattern: () => void;
  loadFields: (bbox: BBox) => Promise<void>;
  runPattern: () => Promise<void>;
}

function toError(error: unknown): FieldsError {
  if (error instanceof FieldsClientError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.message) return { code: "UNKNOWN", message: error.message };
  return { code: "UNKNOWN", message: "Unexpected failure. Try again shortly." };
}

export const useFieldsStore = create<FieldsState>((set, get) => ({
  visible: true,
  year: 2024,
  minConfidence: 69,
  grouping: false,

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
    }),

  loadFields: async (bbox) => {
    if (get().loading) return;
    const { year, minConfidence } = get();
    set({
      loading: true,
      error: null,
      patternError: null,
      // New selection invalidates any previous pattern run.
      pattern: null,
      patternStage: null,
      patternMonthsDone: 0,
      selectedFieldId: null,
    });
    try {
      const result = await fetchFields({ bbox, year, minConfidence });
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
      });
    }
  },

  runPattern: async () => {
    const state = get();
    if (state.patternRunning || !state.bbox || !state.fields) return;
    set({
      patternRunning: true,
      patternError: null,
      pattern: null,
      patternStage: "fields",
      patternMonthsDone: 0,
      selectedFieldId: null,
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
          onStage: (stage) => set({ patternStage: stage }),
          onMonth: () =>
            set((s) => ({ patternMonthsDone: Math.min(12, s.patternMonthsDone + 1) })),
        },
      );
      set({
        patternRunning: false,
        patternStage: null,
        pattern: result,
        patternMonthsDone: 12,
      });
    } catch (error) {
      set({
        patternRunning: false,
        patternStage: null,
        patternError: toError(error),
      });
    }
  },
}));

/** Pattern field rows keyed by feature id (map fill + panel list). */
export function patternById(
  pattern: PatternClientResult | null,
): Map<string, PatternClientResult["fields"][number]> {
  const map = new Map<string, PatternClientResult["fields"][number]>();
  if (!pattern) return map;
  for (const field of pattern.fields) map.set(field.id, field);
  return map;
}
