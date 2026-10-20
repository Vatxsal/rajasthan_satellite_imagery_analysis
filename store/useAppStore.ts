import { create } from "zustand";
import type {
  AreaLevel,
  BBox,
  CompositeId,
  District,
  Ilr,
  Scene,
  Tehsil,
} from "@/lib/data";
import { dataAdapter } from "@/lib/data";
import type { BasemapId } from "@/lib/map/constants";
import {
  DOWNLOAD_FORMAT_LABELS,
  downloadScene,
  planDownload,
  type DownloadFormat,
  type DownloadPlan,
  type DownloadTarget,
} from "@/lib/downloads";

export interface AreaSelection {
  level: AreaLevel;
  id: string;
  name: string;
  geometry: GeoJSON.Polygon;
  bbox: BBox;
}

export type SidebarTabId = "filters" | "layers" | "distance" | "queries";

export type AdminLayerId = "districts" | "tehsils" | "ilrs";

export type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  /** ms until auto-dismiss; null = stays until dismissed or updated. */
  duration: number | null;
}

/** Reduced-resolution download the user must confirm before it runs. */
export interface DownloadDialogState {
  scene: Scene;
  target: DownloadTarget;
  format: DownloadFormat;
  plan: DownloadPlan;
}

function toSelection(
  level: AreaLevel,
  area: { id: string; name: string; geometry: GeoJSON.Polygon; bbox: BBox },
): AreaSelection {
  return { level, id: area.id, name: area.name, geometry: area.geometry, bbox: area.bbox };
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

interface AppState {
  // layout ------------------------------------------------------------
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  resultsOpen: boolean;
  /** Measured height of the docked results strip; map controls follow it. */
  stripHeightPx: number;
  setStripHeightPx: (value: number) => void;
  sidebarTab: SidebarTabId;
  toggleSidebar: () => void;
  setSidebarCollapsed: (value: boolean) => void;
  toggleResults: () => void;
  setResultsOpen: (value: boolean) => void;
  setSidebarTab: (tab: SidebarTabId) => void;

  // area filters / selection -------------------------------------------
  districtId: string | null;
  tehsilId: string | null;
  ilrId: string | null;
  districtSel: AreaSelection | null;
  tehsilSel: AreaSelection | null;
  ilrSel: AreaSelection | null;
  setDistrict: (district: District | null) => void;
  setTehsil: (tehsil: Tehsil | null) => void;
  setIlr: (ilr: Ilr | null) => void;

  // search filters ------------------------------------------------------
  fromDate: string;
  toDate: string;
  maxCloudCover: number;
  composite: CompositeId;
  /** Viewport month of the available-dates calendar (null = anchor on scenes). */
  calendarMonth: { year: number; month: number } | null;
  setCalendarMonth: (value: { year: number; month: number } | null) => void;
  setFromDate: (value: string) => void;
  setToDate: (value: string) => void;
  setMaxCloudCover: (value: number) => void;
  setComposite: (value: CompositeId) => void;
  clearFilters: () => void;

  // map -----------------------------------------------------------------
  basemap: BasemapId;
  setBasemap: (value: BasemapId) => void;
  adminLayers: Record<AdminLayerId, boolean>;
  toggleAdminLayer: (layer: AdminLayerId) => void;
  imageryVisible: boolean;
  imageryOpacity: number;
  toggleImagery: () => void;
  setImageryOpacity: (value: number) => void;
  /** Layers tab: keep the active scene's tile footprint outline on the map. */
  sceneFootprintVisible: boolean;
  toggleSceneFootprint: () => void;
  /** Transient: scene card being hovered (shows that scene's footprint). */
  hoveredSceneId: string | null;
  setHoveredScene: (id: string | null) => void;
  measureActive: boolean;
  toggleMeasure: () => void;
  homeNonce: number;
  locateNonce: number;
  requestHome: () => void;
  requestLocate: () => void;

  // results ---------------------------------------------------------------
  scenes: Scene[];
  searching: boolean;
  hasSearched: boolean;
  searchError: string | null;
  activeSceneId: string | null;
  runSearch: () => Promise<void>;
  setActiveScene: (id: string | null) => void;

  // live imagery overlay ---------------------------------------------------
  imageryLoading: boolean;
  imageryError: string | null;
  setImageryLoading: (value: boolean) => void;
  setImageryError: (message: string | null) => void;

  // toasts ------------------------------------------------------------------
  toasts: ToastItem[];
  pushToast: (toast: { tone: ToastTone; message: string; duration?: number | null }) => number;
  updateToast: (
    id: number,
    patch: { tone?: ToastTone; message?: string; duration?: number | null },
  ) => void;
  dismissToast: (id: number) => void;

  // downloads ----------------------------------------------------------------
  /** Format currently being prepared/fetched (drives "Preparing…" states). */
  downloadBusy: DownloadFormat | null;
  /** Open reduced-resolution confirmation dialog, if any. */
  downloadDialog: DownloadDialogState | null;
  requestDownload: (scene: Scene, target: DownloadTarget, format: DownloadFormat) => void;
  confirmReducedDownload: () => void;
  cancelReducedDownload: () => void;
}

let toastSeq = 0;

export const useAppStore = create<AppState>((set, get) => {
  /** Shared download execution: progress toast → fetch → success/error toast. */
  const runDownload = async (args: DownloadDialogState) => {
    const { scene, target, format, plan } = args;
    set({ downloadBusy: format });
    const toastId = get().pushToast({
      tone: "info",
      message: `Preparing ${DOWNLOAD_FORMAT_LABELS[format]} download…`,
      duration: null,
    });
    const result = await downloadScene(scene, target, format, { size: plan.size });
    set({ downloadBusy: null });
    if (result.ok) {
      get().updateToast(toastId, {
        tone: "success",
        message: `Saved ${result.filename}`,
        duration: 5000,
      });
    } else {
      get().updateToast(toastId, { tone: "error", message: result.message, duration: null });
    }
  };

  return {
  sidebarOpen: false,
  sidebarCollapsed: false,
  resultsOpen: true,
  stripHeightPx: 148,
  setStripHeightPx: (value) => {
    if (get().stripHeightPx === value) return;
    set({ stripHeightPx: value });
  },
  sidebarTab: "filters",
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
  toggleResults: () => set((s) => ({ resultsOpen: !s.resultsOpen })),
  setResultsOpen: (value) => set({ resultsOpen: value }),
  setSidebarTab: (tab) => set({ sidebarTab: tab, sidebarCollapsed: false, sidebarOpen: true }),

  districtId: null,
  tehsilId: null,
  ilrId: null,
  districtSel: null,
  tehsilSel: null,
  ilrSel: null,
  setDistrict: (district) =>
    set({
      districtId: district?.id ?? null,
      tehsilId: null,
      ilrId: null,
      tehsilSel: null,
      ilrSel: null,
      districtSel: district ? toSelection("district", district) : null,
    }),
  setTehsil: (tehsil) =>
    set({
      tehsilId: tehsil?.id ?? null,
      ilrId: null,
      ilrSel: null,
      tehsilSel: tehsil ? toSelection("tehsil", tehsil) : null,
    }),
  setIlr: (ilr) =>
    set({
      ilrId: ilr?.id ?? null,
      ilrSel: ilr ? toSelection("ilr", ilr) : null,
    }),

  fromDate: isoDay(-90),
  toDate: isoDay(0),
  maxCloudCover: 20,
  composite: "true-color",
  calendarMonth: null,
  setCalendarMonth: (value) => set({ calendarMonth: value }),
  setFromDate: (value) => set({ fromDate: value }),
  setToDate: (value) => set({ toDate: value }),
  setMaxCloudCover: (value) => set({ maxCloudCover: value }),
  setComposite: (value) => set({ composite: value }),
  clearFilters: () =>
    set({
      districtId: null,
      tehsilId: null,
      ilrId: null,
      districtSel: null,
      tehsilSel: null,
      ilrSel: null,
      fromDate: isoDay(-90),
      toDate: isoDay(0),
      maxCloudCover: 20,
      composite: "true-color",
      scenes: [],
      hasSearched: false,
      searchError: null,
      activeSceneId: null,
    }),

  basemap: "streets",
  setBasemap: (value) => set({ basemap: value }),
  adminLayers: { districts: true, tehsils: false, ilrs: false },
  toggleAdminLayer: (layer) =>
    set((s) => ({ adminLayers: { ...s.adminLayers, [layer]: !s.adminLayers[layer] } })),
  imageryVisible: false,
  /** Real (cdse) imagery defaults to fully opaque; mock placeholder is fine too. */
  imageryOpacity: 1,
  toggleImagery: () => set((s) => ({ imageryVisible: !s.imageryVisible })),
  setImageryOpacity: (value) => set({ imageryOpacity: value }),
  sceneFootprintVisible: false,
  toggleSceneFootprint: () =>
    set((s) => ({ sceneFootprintVisible: !s.sceneFootprintVisible })),
  hoveredSceneId: null,
  setHoveredScene: (id) => set({ hoveredSceneId: id }),
  measureActive: false,
  toggleMeasure: () => set((s) => ({ measureActive: !s.measureActive })),
  homeNonce: 0,
  locateNonce: 0,
  requestHome: () => set((s) => ({ homeNonce: s.homeNonce + 1 })),
  requestLocate: () => set((s) => ({ locateNonce: s.locateNonce + 1 })),

  scenes: [],
  searching: false,
  hasSearched: false,
  searchError: null,
  activeSceneId: null,
  runSearch: async () => {
    const params = {
      districtId: get().districtId,
      tehsilId: get().tehsilId,
      ilrId: get().ilrId,
      fromDate: get().fromDate,
      toDate: get().toDate,
      maxCloudCover: get().maxCloudCover,
      composite: get().composite,
    };
    set({ searching: true, hasSearched: true, resultsOpen: true, activeSceneId: null, searchError: null });
    try {
      const scenes = await dataAdapter.searchScenes(params);
      set({ scenes, searching: false, searchError: null });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Search failed. Try again shortly.";
      set({ scenes: [], searching: false, searchError: message });
    }
  },
  setActiveScene: (id) => set({ activeSceneId: id }),

  imageryLoading: false,
  imageryError: null,
  setImageryLoading: (value) => set({ imageryLoading: value }),
  setImageryError: (message) => set({ imageryError: message }),

  toasts: [],
  pushToast: ({ tone, message, duration = 6000 }) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, tone, message, duration }] }));
    return id;
  },
  updateToast: (id, patch) =>
    set((s) => ({
      toasts: s.toasts.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)),
    })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) })),

  downloadBusy: null,
  downloadDialog: null,
  requestDownload: (scene, target, format) => {
    if (get().downloadBusy || get().downloadDialog) return;
    const plan = planDownload(target);
    if (plan.reduced) {
      set({ downloadDialog: { scene, target, format, plan } });
      return;
    }
    void runDownload({ scene, target, format, plan });
  },
  confirmReducedDownload: () => {
    const dialog = get().downloadDialog;
    if (!dialog) return;
    set({ downloadDialog: null });
    void runDownload(dialog);
  },
  cancelReducedDownload: () => set({ downloadDialog: null }),
  };
});

/** Highest-priority active area selection (ILR > tehsil > district). */
export const selectActiveSelection = (s: AppState): AreaSelection | null =>
  s.ilrSel ?? s.tehsilSel ?? s.districtSel;

export const useActiveSelection = (): AreaSelection | null =>
  useAppStore(selectActiveSelection);

export const useActiveScene = (): Scene | null =>
  useAppStore((s) => s.scenes.find((scene) => scene.id === s.activeSceneId) ?? null);
