import { create } from "zustand";
import type { Sensitivity } from "@/lib/analysis/config";
import type { CompareStats } from "@/lib/analysis/types";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { streamAnalyze } from "@/lib/compare/run";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";

export type CompareTab = "swipe" | "change-map" | "statistics" | "hotspots";
export type CompareStage = "fetch-a" | "fetch-b" | "analyze";
export type CompareSlot = "dateA" | "dateB";
export type CompareAiStatus = "idle" | "loading" | "done" | "error";

/** Progress frames → human labels for the compare bar. */
export const COMPARE_STAGE_LABELS: Record<CompareStage, string> = {
  "fetch-a": "Fetching date A",
  "fetch-b": "Fetching date B",
  analyze: "Analyzing",
};

/** Result of a completed analysis plus the grid bbox it was rendered for. */
export interface CompareResult {
  key: string;
  overlayUrl: string;
  aiEnabled: boolean;
  stats: CompareStats;
  /** Analysis-grid bbox (geometry bbox, same as the server) for the image source. */
  bbox: [number, number, number, number];
}

interface CompareState {
  /** Scene strip "Compare" toggle — A/B assignment only works while armed. */
  compareMode: boolean;
  dateA: string | null;
  dateB: string | null;
  running: boolean;
  stage: CompareStage | null;
  error: { code: string; message: string } | null;
  result: CompareResult | null;
  tab: CompareTab;
  drawerOpen: boolean;
  /** Classified overlay opacity (map layer). */
  overlayOpacity: number;
  /** Class-code → visible. Recolour happens client-side on the overlay PNG. */
  classVisible: Record<number, boolean>;
  sensitivity: Sensitivity;
  minPatchHa: number;
  /** Swipe divider position, percent from the left edge (0-100). */
  divider: number;
  aiStatus: CompareAiStatus;
  aiText: string | null;
  aiError: string | null;

  toggleCompareMode: () => void;
  toggleSlot: (date: string, slot: CompareSlot) => void;
  clearPair: () => void;
  run: () => Promise<void>;
  setTab: (tab: CompareTab) => void;
  setDrawerOpen: (value: boolean) => void;
  setOverlayOpacity: (value: number) => void;
  toggleClass: (code: number) => void;
  setSensitivity: (value: Sensitivity) => void;
  setMinPatchHa: (value: number) => void;
  setDivider: (value: number) => void;
  requestSummary: () => Promise<void>;
}

/** Active run — kept out of the store state (AbortController is not reactive). */
let activeController: AbortController | null = null;
/** Monotonic run id: results from an aborted/superseded run are discarded. */
let runSeq = 0;

function toast(tone: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast({ tone, message, duration: 5000 });
}

function resetRunState() {
  runSeq += 1;
  activeController?.abort();
  activeController = null;
  return runSeq;
}

export const useCompareStore = create<CompareState>((set, get) => ({
  compareMode: false,
  dateA: null,
  dateB: null,
  running: false,
  stage: null,
  error: null,
  result: null,
  tab: "change-map",
  drawerOpen: false,
  overlayOpacity: 0.85,
  classVisible: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true },
  sensitivity: "medium",
  minPatchHa: 0.2,
  divider: 50,
  aiStatus: "idle",
  aiText: null,
  aiError: null,

  toggleCompareMode: () => {
    const next = !get().compareMode;
    if (!next) {
      // Leaving compare mode drops the pair, the result and the drawer.
      resetRunState();
      set({
        compareMode: false,
        dateA: null,
        dateB: null,
        running: false,
        stage: null,
        error: null,
        result: null,
        drawerOpen: false,
        aiStatus: "idle",
        aiText: null,
        aiError: null,
      });
      return;
    }
    set({ compareMode: true });
  },

  toggleSlot: (date, slot) => {
    const state = get();
    if (state.running) return;
    const current = slot === "dateA" ? state.dateA : state.dateB;
    const other = slot === "dateA" ? state.dateB : state.dateA;
    if (current === date) {
      // Clicking the active slot clears it.
      set(slot === "dateA" ? { dateA: null } : { dateB: null });
      return;
    }
    if (other === date) {
      toast("error", "Pick two different dates to compare.");
      return;
    }
    set(slot === "dateA" ? { dateA: date } : { dateB: date });
  },

  clearPair: () => {
    if (get().running) return;
    resetRunState();
    set({ dateA: null, dateB: null, result: null, error: null, drawerOpen: false, aiStatus: "idle", aiText: null, aiError: null });
  },

  run: async () => {
    const state = get();
    const selection = selectActiveSelection(useAppStore.getState());
    if (state.running || !state.dateA || !state.dateB) return;
    if (!selection) {
      toast("error", "Select a district, tehsil or ILR first.");
      return;
    }

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const seq = ++runSeq;
    const bbox = bboxFromGeometry(selection.geometry);
    if (!bbox) {
      activeController = null;
      toast("error", "Could not read the selected area geometry.");
      return;
    }

    set({ running: true, stage: "fetch-a", error: null, aiStatus: "idle", aiText: null, aiError: null });

    try {
      const result = await streamAnalyze(
        {
          areaId: selection.id,
          level: selection.level,
          dateA: state.dateA,
          dateB: state.dateB,
          sensitivity: state.sensitivity,
          minPatchHa: state.minPatchHa,
        },
        {
          signal: controller.signal,
          onStage: (stage) => {
            if (seq === runSeq) set({ stage });
          },
        },
      );
      if (seq !== runSeq) return; // superseded or cancelled
      activeController = null;
      set({
        running: false,
        stage: null,
        error: null,
        result: { ...result, bbox },
        drawerOpen: true,
        tab: "change-map",
        aiStatus: "idle",
        aiText: null,
        aiError: null,
      });
    } catch (error) {
      if (controller.signal.aborted || seq !== runSeq) {
        // Cancelled (area/scenes changed or mode toggled) — stay quiet.
        if (seq === runSeq) set({ running: false, stage: null });
        return;
      }
      activeController = null;
      const err = error as { code?: string; message?: string };
      const code = typeof err.code === "string" ? err.code : "ANALYZE_FAILED";
      const message =
        typeof err.message === "string" && err.message
          ? err.message
          : "Change detection failed. Try again shortly.";
      set({ running: false, stage: null, error: { code, message } });
      toast("error", message);
    }
  },

  setTab: (tab) => set({ tab }),
  setDrawerOpen: (value) => set({ drawerOpen: value }),
  setOverlayOpacity: (value) => set({ overlayOpacity: Math.max(0, Math.min(1, value)) }),
  toggleClass: (code) =>
    set((s) => ({ classVisible: { ...s.classVisible, [code]: !s.classVisible[code] } })),
  setSensitivity: (value) => set({ sensitivity: value }),
  setMinPatchHa: (value) => set({ minPatchHa: Math.max(0.01, Math.min(100, value)) }),
  setDivider: (value) => set({ divider: Math.max(0, Math.min(100, value)) }),

  requestSummary: async () => {
    const { result, aiStatus } = get();
    if (!result || aiStatus === "loading") return;
    set({ aiStatus: "loading", aiError: null });
    try {
      const response = await fetch("/api/compare/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stats: result.stats }),
      });
      const body = (await response.json().catch(() => null)) as { text?: string; message?: string } | null;
      if (!response.ok || !body?.text) {
        throw new Error(body?.message ?? "AI summary is unavailable right now.");
      }
      set({ aiStatus: "done", aiText: body.text });
    } catch (error) {
      set({
        aiStatus: "error",
        aiError: error instanceof Error && error.message ? error.message : "AI summary failed.",
      });
    }
  },
}));

/**
 * A new search or a different area invalidates the pair: the analysed
 * polygons/dates belong to the old context. Wired once at module load —
 * zustand hands the listener (state, prevState).
 */
useAppStore.subscribe((prev, next) => {
  const prevSel = selectActiveSelection(prev);
  const nextSel = selectActiveSelection(next);
  const selectionChanged =
    (prevSel?.level ?? null) !== (nextSel?.level ?? null) || (prevSel?.id ?? null) !== (nextSel?.id ?? null);
  const scenesChanged = prev.scenes !== next.scenes;
  if (!selectionChanged && !scenesChanged) return;
  const compare = useCompareStore.getState();
  if (compare.running) {
    // Abort the in-flight run first, then drop the pair.
    resetRunState();
    useCompareStore.setState({ running: false, stage: null });
  }
  if (compare.dateA || compare.dateB || compare.result) {
    useCompareStore.setState({
      dateA: null,
      dateB: null,
      result: null,
      error: null,
      drawerOpen: false,
      aiStatus: "idle",
      aiText: null,
      aiError: null,
    });
  }
});
