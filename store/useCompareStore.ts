import { create } from "zustand";
import type { Sensitivity } from "@/lib/analysis/config";
import type { CompareStats, ConfidenceTier, SummaryData, SummaryLanguage } from "@/lib/analysis/types";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { filterEvents } from "@/lib/compare/eventList";
import { analysisParamsFromMetadata, analysisParamsQuery } from "@/lib/compare/params";
import { normalizeComparePair } from "@/lib/compare/swipe";
import { streamAnalyze } from "@/lib/compare/run";
import type { CompositeId } from "@/lib/data";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";
import { selectCan, useSession } from "@/store/useSession";

export type CompareTab = "swipe" | "change-map" | "statistics" | "hotspots" | "summary";
export type CompareStage = "fetch-a" | "fetch-b" | "analyze";
export type CompareSlot = "dateA" | "dateB";
export type CompareSummaryStatus = "idle" | "loading" | "done" | "error";
/** Which server step a loading summary is in (artifact recompute vs Gemini). */
export type CompareSummaryPhase = "ensure" | "write" | null;
/** Events list lifecycle: idle = never shown yet, ready = loaded (even if empty). */
export type CompareEventsStatus = "idle" | "loading" | "ready" | "error";
/** Engine v2 input mode — median composite vs the single date each. */
export type CompareInputMode = "single" | "composite";
/** Swipe-tab right-hand side: the second date or the Esri satellite basemap. */
export type CompareSwipeMode = "dates" | "basemap";

/** One page of change events — client cursor growth step AND server page size. */
const EVENTS_PAGE_SIZE = 100;

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
  /**
   * Inline change events (first ANALYZE_EVENTS_CAP from the analyze stream).
   * The Events list AND the map markers read these — no follow-up fetch, so
   * the tab works the instant a run finishes (and survives cold caches).
   */
  events: GeoJSON.Feature[];
  /** Analysis-grid bbox (geometry bbox, same as the server) for the image source. */
  bbox: [number, number, number, number];
}

/** Side panel width bounds (desktop compare results panel). */
export const PANEL_WIDTH_MIN = 360;
export const PANEL_WIDTH_MAX = 600;

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
  /** Engine v2 inputs: ±window composite or each scene's single day. */
  inputMode: CompareInputMode;
  /** Minimum confidence tier for the events list (null = all events).
   *  Default Medium+ for v2 results (Phase 5); v1 runs reset to null. */
  confidenceFilter: ConfidenceTier | null;
  /** Loaded change events, raw and unfiltered (inline from analyze + server pages).
   *  List rows and map markers both derive from this via lib/compare/eventList. */
  eventsItems: GeoJSON.Feature[];
  /** Total change events for the raw set (stats.eventsTotal / server page total). */
  eventsTotal: number;
  /** Exact total matching the active confidence filter (probe result; null = unknown). */
  eventsFilteredTotal: number | null;
  /** Client page cursor: how many visible events the list shows (and markers number). */
  eventsLimit: number;
  eventsStatus: CompareEventsStatus;
  eventsError: string | null;
  /** Swipe divider position, percent from the left edge (0-100). */
  divider: number;
  /** Swipe-tab raster composite shown for BOTH dates (raw imagery control). */
  swipeComposite: CompositeId;
  /** Right-hand side of the swipe: date B or the Esri satellite basemap. */
  swipeMode: CompareSwipeMode;
  /** Neutral grey outline of the analysed area on the swipe maps. */
  swipeOutline: boolean;
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
  /** Which phase the loading summary is in ("ensure" = artifact recompute). */
  summaryPhase: CompareSummaryPhase;
  summaryData: SummaryData | null;
  summaryError: string | null;
  /** Contract code of the last failed summary request (AI_* …). */
  summaryErrorCode: string | null;
  /** Last success fell back to statistics-only (the images were rejected). */
  summaryImagesFallback: boolean;
  /** Opened via an emailed report deep link (drawer shows a quiet banner). */
  shareOpened: boolean;

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
  setInputMode: (value: CompareInputMode) => void;
  setConfidenceFilter: (value: ConfidenceTier | null) => void;
  /** Advances the events view: grows the client cursor when rows are already
   *  loaded, else fetches the next raw server page (stateless recompute on a
   *  cold cache — params included). */
  loadMoreEvents: () => Promise<void>;
  /** Best-effort exact total for the active confidence filter (limit=1 probe). */
  probeEventsTotal: () => Promise<void>;
  setDivider: (value: number) => void;
  setSwipeComposite: (value: CompositeId) => void;
  setSwipeMode: (value: CompareSwipeMode) => void;
  setSwipeOutline: (value: boolean) => void;
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
  /** Marks the current result as opened from an emailed report link. */
  markShareOpened: () => void;
}

/** Active run — kept out of the store state (AbortController is not reactive). */
let activeController: AbortController | null = null;
/** Monotonic run id: results from an aborted/superseded run are discarded. */
let runSeq = 0;
/** Monotonic events id: pages superseded by a filter change are discarded. */
let eventsSeq = 0;

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
  summaryErrorCode: null as string | null,
  summaryImagesFallback: false,
  choropleth: false,
  hoveredHotspot: null as number | null,
  selectedHotspot: null as number | null,
  tehsilHighlight: null as { id: string; name: string } | null,
  confidenceFilter: "medium" as ConfidenceTier | null,
  eventsItems: [] as GeoJSON.Feature[],
  eventsTotal: 0,
  eventsFilteredTotal: null as number | null,
  eventsLimit: EVENTS_PAGE_SIZE,
  eventsStatus: "idle" as CompareEventsStatus,
  eventsError: null as string | null,
  shareOpened: false,
};

function summaryIdle() {
  return {
    summaryStatus: "idle" as CompareSummaryStatus,
    summaryPhase: null as CompareSummaryPhase,
    summaryData: null as SummaryData | null,
    summaryError: null as string | null,
    summaryErrorCode: null as string | null,
    summaryImagesFallback: false,
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
  inputMode: "composite",
  confidenceFilter: "medium",
  eventsItems: [],
  eventsTotal: 0,
  eventsFilteredTotal: null,
  eventsLimit: EVENTS_PAGE_SIZE,
  eventsStatus: "idle",
  eventsError: null,
  divider: 50,
  swipeComposite: "true-color",
  swipeMode: "dates",
  swipeOutline: true,
  boostVisibility: true,
  stripExpanded: false,
  panelWidth: 420,
  choropleth: false,
  hoveredHotspot: null,
  selectedHotspot: null,
  tehsilHighlight: null,
  summaryLanguage: "en",
  summaryIncludeImages: true,
  summaryStatus: "idle",
  summaryPhase: null,
  summaryData: null,
  summaryError: null,
  summaryErrorCode: null,
  summaryImagesFallback: false,
  shareOpened: false,

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
    // A is always the earlier date — silently swap reversed picks.
    const pair = normalizeComparePair(
      slot === "dateA" ? date : state.dateA,
      slot === "dateB" ? date : state.dateB,
    );
    set(pair);
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
    // Guests may use a district only as a parent for tehsil / ILR navigation.
    if (selection.level === "district" && !selectCan(useSession.getState(), "compare.district")) {
      toast("error", "Pick a tehsil or ILR — district-level compare needs an SSO ID.");
      return;
    }

    // Analyse in chronological order: A = earlier, B = later.
    const pair = normalizeComparePair(state.dateA, state.dateB);
    if (!pair.dateA || !pair.dateB) return; // unreachable — guarded above

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

    set({
      dateA: pair.dateA,
      dateB: pair.dateB,
      running: true,
      stage: "fetch-a",
      error: null,
      ...summaryIdle(),
    });

    try {
      const result = await streamAnalyze(
        {
          areaId: selection.id,
          level: selection.level,
          dateA: pair.dateA,
          dateB: pair.dateB,
          sensitivity: state.sensitivity,
          minPatchHa: state.minPatchHa,
          inputMode: state.inputMode,
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
      eventsSeq += 1; // discard events pages still in flight for the old result
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
        // v2 results open at Medium+ (Phase 5 default); v1 events carry no
        // confidence tiers, so a tier filter would hide every v1 row.
        confidenceFilter: result.stats.metadata.engine === "v2" ? "medium" : null,
        // Single source: the list + map markers start from the inline events —
        // no follow-up fetch, no "expired" on a cold server cache.
        eventsItems: result.events,
        eventsTotal: result.stats.eventsTotal ?? result.events.length,
        eventsFilteredTotal: null,
        eventsLimit: EVENTS_PAGE_SIZE,
        eventsStatus: "ready" as CompareEventsStatus,
        eventsError: null,
        shareOpened: false,
        ...summaryIdle(),
      });
      // Exact filtered total for the header (v2 opens with Medium+ active).
      if (get().confidenceFilter) void get().probeEventsTotal();
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
  setInputMode: (value) => set({ inputMode: value }),
  setConfidenceFilter: (value) => {
    eventsSeq += 1; // in-flight pages/probes belong to the old filter
    // Items stay loaded: the filter is applied client-side (list + markers
    // update instantly from the same array), only the cursor resets.
    set({
      confidenceFilter: value,
      eventsLimit: EVENTS_PAGE_SIZE,
      eventsFilteredTotal: null,
      // A result exists → the list is served from its inline events, so the
      // view stays ready (empty only when nothing matches the filter).
      eventsStatus: get().result ? "ready" : "idle",
      eventsError: null,
    });
    if (value && get().result) void get().probeEventsTotal();
  },

  probeEventsTotal: async () => {
    const state = get();
    const result = state.result;
    const filter = state.confidenceFilter;
    if (!result || !filter) return;
    try {
      const query = analysisParamsQuery(result.stats.metadata);
      query.set("key", result.key);
      query.set("limit", "1");
      query.set("offset", "0");
      query.set("confidence", filter);
      const response = await fetch(`/api/compare/events?${query}`);
      const body = (await response.json().catch(() => null)) as { total?: number } | null;
      if (!response.ok || typeof body?.total !== "number") return;
      const current = get();
      // Discard stale probes (filter or result changed while it was in flight).
      if (current.result?.key !== result.key || current.confidenceFilter !== filter) return;
      set({ eventsFilteredTotal: body.total });
    } catch {
      // Best-effort: the header falls back to the loaded count.
    }
  },

  loadMoreEvents: async () => {
    const state = get();
    if (!state.result || state.eventsStatus === "loading") return;
    const result = state.result;
    const filter = state.confidenceFilter;

    // Rows already loaded but past the cursor → just advance it (no network).
    const loadedMatches = filterEvents(state.eventsItems, filter);
    if (state.eventsLimit < loadedMatches.length) {
      set({ eventsLimit: state.eventsLimit + EVENTS_PAGE_SIZE });
      return;
    }
    // Every raw row is in — nothing left to fetch (cursor growth covered above).
    if (state.eventsItems.length >= state.eventsTotal) return;

    const seq = ++eventsSeq;
    set({ eventsStatus: "loading", eventsError: null });
    try {
      const query = analysisParamsQuery(result.stats.metadata);
      query.set("key", result.key);
      query.set("limit", String(EVENTS_PAGE_SIZE));
      query.set("offset", String(state.eventsItems.length));
      const response = await fetch(`/api/compare/events?${query}`);
      const body = (await response.json().catch(() => null)) as {
        total?: number;
        events?: GeoJSON.Feature[];
        message?: string;
      } | null;
      if (!response.ok || !body || !Array.isArray(body.events)) {
        throw new Error(body?.message ?? "Change events are unavailable. Run the analysis again.");
      }
      // Discard superseded responses (filter/result changed while in flight).
      if (seq !== eventsSeq || get().result?.key !== result.key) return;
      const current = get();
      const seen = new Set(
        current.eventsItems.map((feature) => String(feature.id ?? (feature.properties as { id?: unknown } | undefined)?.id ?? "")),
      );
      const additions = body.events.filter(
        (feature) => !seen.has(String(feature.id ?? (feature.properties as { id?: unknown } | undefined)?.id ?? "")),
      );
      set({
        eventsStatus: "ready",
        eventsTotal: typeof body.total === "number" ? body.total : current.eventsTotal,
        eventsItems: [...current.eventsItems, ...additions],
        eventsLimit: current.eventsLimit + EVENTS_PAGE_SIZE,
        eventsError: null,
      });
    } catch (error) {
      if (seq !== eventsSeq || get().result?.key !== result.key) return;
      set({
        eventsStatus: "error",
        eventsError:
          error instanceof Error && error.message ? error.message : "Change events failed to load.",
      });
    }
  },
  setDivider: (value) => set({ divider: Math.max(0, Math.min(100, value)) }),
  setSwipeComposite: (value) => set({ swipeComposite: value }),
  setSwipeMode: (value) => set({ swipeMode: value }),
  setSwipeOutline: (value) => set({ swipeOutline: value }),
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
  markShareOpened: () => set({ shareOpened: true }),

  fetchSummary: async () => {
    const { result, summaryStatus, summaryLanguage, summaryIncludeImages } = get();
    if (!result || summaryStatus === "loading") return;
    const metadata = result.stats.metadata;
    set({
      summaryStatus: "loading",
      summaryError: null,
      summaryErrorCode: null,
      summaryImagesFallback: false,
      summaryPhase: "ensure",
    });
    try {
      // Probe with analysis params: warms/verifies the artifact first so the
      // caption can say "re-running the analysis" instead of silently hanging
      // on a cold cache. The POST below recomputes too (in-flight deduped) —
      // a failed probe just falls through to it.
      try {
        const probe = analysisParamsQuery(metadata);
        probe.set("key", result.key);
        probe.set("limit", "1");
        probe.set("offset", "0");
        await fetch(`/api/compare/events?${probe}`);
      } catch {
        // Network hiccup — the POST below surfaces real failures.
      }
      set({ summaryPhase: "write" });
      const response = await fetch("/api/compare/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisKey: result.key,
          language: summaryLanguage,
          includeImages: summaryIncludeImages,
          ...analysisParamsFromMetadata(metadata),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        summary?: SummaryData;
        message?: string;
        code?: string;
        imagesFallback?: boolean;
      } | null;
      if (!response.ok || !body?.summary) {
        throw Object.assign(new Error(body?.message ?? "AI summary is unavailable right now."), {
          code: typeof body?.code === "string" ? body.code : null,
        });
      }
      set({
        summaryStatus: "done",
        summaryData: body.summary,
        summaryImagesFallback: Boolean(body.imagesFallback),
        summaryPhase: null,
      });
    } catch (error) {
      set({
        summaryStatus: "error",
        summaryError: error instanceof Error && error.message ? error.message : "AI summary failed.",
        summaryErrorCode:
          typeof (error as { code?: unknown }).code === "string"
            ? ((error as { code: string }).code)
            : null,
        summaryPhase: null,
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
