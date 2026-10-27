import { create } from "zustand";
import type { Sensitivity } from "@/lib/analysis/config";
import type { CompareStats, SummaryData, SummaryLanguage } from "@/lib/analysis/types";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { streamAnalyze } from "@/lib/compare/run";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";

export type CompareTab = "swipe" | "change-map" | "statistics" | "hotspots" | "summary";
export type CompareStage = "fetch-a" | "fetch-b" | "analyze";
export type CompareSlot = "dateA" | "dateB";
export type CompareSummaryStatus = "idle" | "loading" | "done" | "error";

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

/** Side panel width bounds (desktop compare results panel). */
export const PANEL_WIDTH_MIN = 340;
export const PANEL_WIDTH_MAX = 560;

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
  /** Display-only dilation + outline so small changes stay visible (default on). */
  boostVisibility: boolean;
  /** Slim compare strip: scene cards hidden until expanded. */
  stripExpanded: boolean;
  /** Desktop results panel width in px. */
  panelWidth: number;
  /** Per-tehsil shading layer (district-level results only). */
  choropleth: boolean;
  /** Hotspot rank hovered in the list or on the map (1-based). */
  hoveredHotspot: number | null;
  /** Hotspot rank selected (popup open, fly-to done). */
  selectedHotspot: number | null;
  /** Tehsil highlighted because its stats row was clicked. */
  tehsilHighlight: { id: string; name: string } | null;
  /** Structured AI summary (server-side Gemini). */
  summaryLanguage: SummaryLanguage;
  summaryIncludeImages: boolean;
  summaryStatus: CompareSummaryStatus;
  summaryData: SummaryData | null;
  summaryError: string | null;

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
  setBoostVisibility: (value: boolean) => void;
  setStripExpanded: (value: boolean) => void;
  setPanelWidth: (value: number) => void;
  toggleChoropleth: () => void;
  setHoveredHotspot: (rank: number | null) => void;
  setSelectedHotspot: (rank: number | null) => void;
  setTehsilHighlight: (value: { id: string; name: string } | null) => void;
  setSummaryLanguage: (value: SummaryLanguage) => void;
  setSummaryIncludeImages: (value: boolean) => void;
  fetchSummary: () => Promise<void>;
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

/** Result-bound display + summary state (kept consistent on every clear path). */
const RESULT_BOUND_RESET = {
  result: null as CompareResult | null,
  drawerOpen: false,
  summaryStatus: "idle" as CompareSummaryStatus,
  summaryData: null as SummaryData | null,
  summaryError: null as string | null,
  choropleth: false,
  hoveredHotspot: null as number | null,
  selectedHotspot: null as number | null,
  tehsilHighlight: null as { id: string; name: string } | null,
};

function summaryIdle() {
  return {
    summaryStatus: "idle" as CompareSummaryStatus,
    summaryData: null as SummaryData | null,
    summaryError: null as string | null,
  };
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
  boostVisibility: true,
  stripExpanded: false,
  panelWidth: 400,
  choropleth: false,
  hoveredHotspot: null,
  selectedHotspot: null,
  tehsilHighlight: null,
  summaryLanguage: "en",
  summaryIncludeImages: true,
  summaryStatus: "idle",
  summaryData: null,
  summaryError: null,

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
        ...RESULT_BOUND_RESET,
        stripExpanded: false,
        ...summaryIdle(),
      });
      return;
    }
    set({ compareMode: true, stripExpanded: false });
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
    set({ dateA: null, dateB: null, error: null, ...RESULT_BOUND_RESET, ...summaryIdle() });
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

    set({ running: true, stage: "fetch-a", error: null, ...summaryIdle() });

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
        choropleth: false,
        hoveredHotspot: null,
        selectedHotspot: null,
        tehsilHighlight: null,
        ...summaryIdle(),
      });
      // Free map space on desktop: results now live in the right-hand panel.
      useAppStore.getState().setSidebarCollapsed(true);
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
  setBoostVisibility: (value) => set({ boostVisibility: value }),
  setStripExpanded: (value) => set({ stripExpanded: value }),
  setPanelWidth: (value) =>
    set({ panelWidth: Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, Math.round(value))) }),
  toggleChoropleth: () => set((s) => ({ choropleth: !s.choropleth })),
  setHoveredHotspot: (rank) => set({ hoveredHotspot: rank }),
  setSelectedHotspot: (rank) => set({ selectedHotspot: rank }),
  setTehsilHighlight: (value) => set({ tehsilHighlight: value }),
  setSummaryLanguage: (value) => set({ summaryLanguage: value }),
  setSummaryIncludeImages: (value) => set({ summaryIncludeImages: value }),

  fetchSummary: async () => {
    const { result, summaryStatus, summaryLanguage, summaryIncludeImages } = get();
    if (!result || summaryStatus === "loading") return;
    set({ summaryStatus: "loading", summaryError: null });
    try {
      const response = await fetch("/api/compare/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisKey: result.key,
          language: summaryLanguage,
          includeImages: summaryIncludeImages,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        summary?: SummaryData;
        message?: string;
      } | null;
      if (!response.ok || !body?.summary) {
        throw new Error(body?.message ?? "AI summary is unavailable right now.");
      }
      set({ summaryStatus: "done", summaryData: body.summary });
    } catch (error) {
      set({
        summaryStatus: "error",
        summaryError: error instanceof Error && error.message ? error.message : "AI summary failed.",
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
      error: null,
      ...RESULT_BOUND_RESET,
      ...summaryIdle(),
    });
  }
});
