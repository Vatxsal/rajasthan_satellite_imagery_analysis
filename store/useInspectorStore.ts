import { create } from "zustand";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { analysisParamsFromMetadata } from "@/lib/compare/params";
import type { District, Tehsil } from "@/lib/data/types";
import type { InspectorHit } from "@/lib/inspect/hits";
import { reversePlace } from "@/lib/inspect/nominatim";
import { pipAdmin } from "@/lib/inspect/pip";
import { useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";

/**
 * Unified map inspector state (Phase 1). ONE card on the whole map: clicking
 * a point — empty spot, fields parcel, change event — or pressing "Inspect
 * map centre" opens it with the pin fixed to that lng/lat. Sections carry
 * their own status and cancel stale work: every open bumps a sequence number
 * and aborts in-flight requests, so data for an old pin never lands on the
 * card.
 *
 * Network use is opt-in and minimal: the location/field sections are computed
 * locally; Nominatim only on the explicit satellite-mode button; the change
 * section posts to the cached compare inspect route; the imagery sample posts
 * to the metered NDVI sample route.
 */

export type SectionStatus = "idle" | "loading" | "done" | "error";

export interface InspectorLocation {
  district: string | null;
  tehsil: string | null;
  ilr: string | null;
}

export interface ChangePatchInfo {
  id: string;
  areaHa: number;
  confidence: string | null;
  confidencePct: number | null;
  evidence: string | null;
}

export interface ChangeInfo {
  kind: "change" | "none" | "masked" | "outside";
  classCode: number;
  classLabel: string;
  patch: ChangePatchInfo | null;
  /** Rank of the clicked event marker/row, when the pin came from one. */
  eventRank: number | null;
}

export interface SampleInfo {
  ndvi: number | null;
  clear: boolean | null;
  date: string;
  composite: string;
}

export interface InspectorState {
  open: boolean;
  pin: [number, number] | null;
  hit: InspectorHit | null;
  /** Plain-words basemap description (streets mode, computed at open time). */
  basemapWords: string[];

  location: InspectorLocation | null;
  lookup: { status: SectionStatus; name: string | null; error: string | null };
  change: { status: SectionStatus; info: ChangeInfo | null; error: string | null };
  sample: { status: SectionStatus; info: SampleInfo | null; error: string | null };

  openAt: (input: {
    lng: number;
    lat: number;
    hit: InspectorHit;
    basemapWords?: string[];
  }) => void;
  inspectCentre: (lng: number, lat: number, basemapWords?: string[]) => void;
  close: () => void;
  setBasemapWords: (words: string[]) => void;
  lookupPlace: () => void;
  sampleNdvi: (scene: { date: string; composite: string }) => void;
  selectAdminArea: (level: "tehsil" | "district") => boolean;
}

const IDLE = { status: "idle" as SectionStatus, name: null, error: null };
const IDLE_CHANGE = { status: "idle" as SectionStatus, info: null, error: null };
const IDLE_SAMPLE = { status: "idle" as SectionStatus, info: null, error: null };

/** Bumped by every open/close so late responses are discarded. */
let seq = 0;
let changeController: AbortController | null = null;
let lookupController: AbortController | null = null;
let sampleController: AbortController | null = null;

function abortAll(): void {
  changeController?.abort();
  lookupController?.abort();
  sampleController?.abort();
  changeController = null;
  lookupController = null;
  sampleController = null;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || `${fallback} (HTTP ${response.status}).`;
}

function openCommon(
  set: (partial: Partial<InspectorState>) => void,
  input: { lng: number; lat: number; hit: InspectorHit; basemapWords?: string[] },
): void {
  seq += 1;
  const mySeq = seq;
  abortAll();

  const admin = pipAdmin(input.lng, input.lat);
  const location: InspectorLocation = {
    district: admin.district?.name ?? null,
    tehsil: admin.tehsil?.name ?? null,
    ilr: admin.ilr?.name ?? null,
  };

  set({
    open: true,
    pin: [input.lng, input.lat],
    hit: input.hit,
    basemapWords: input.basemapWords ?? [],
    location,
    lookup: { ...IDLE },
    change: { ...IDLE_CHANGE },
    sample: { ...IDLE_SAMPLE },
  });

  const result = useCompareStore.getState().result;
  if (!result) return;

  const controller = new AbortController();
  changeController = controller;
  set({ change: { status: "loading", info: null, error: null } });
  void (async () => {
    try {
      const response = await fetch("/api/compare/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          key: result.key,
          ...analysisParamsFromMetadata(result.stats.metadata),
          lng: input.lng,
          lat: input.lat,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "Change lookup failed"));
      const raw = (await response.json()) as ChangeInfo;
      if (seq !== mySeq) return;
      const info: ChangeInfo = {
        ...raw,
        eventRank: input.hit.kind === "event" ? input.hit.rank : null,
      };
      set({ change: { status: "done", info, error: null } });
    } catch (error) {
      if (seq !== mySeq || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Change lookup failed.";
      set({ change: { status: "error", info: null, error: message } });
    } finally {
      if (changeController === controller) changeController = null;
    }
  })();
}

export const useInspectorStore = create<InspectorState>((set, get) => ({
  open: false,
  pin: null,
  hit: null,
  basemapWords: [],
  location: null,
  lookup: { ...IDLE },
  change: { ...IDLE_CHANGE },
  sample: { ...IDLE_SAMPLE },

  openAt: (input) => openCommon(set, input),
  inspectCentre: (lng, lat, basemapWords) =>
    openCommon(set, { lng, lat, hit: { kind: "empty" }, basemapWords }),

  close: () => {
    seq += 1;
    abortAll();
    set({
      open: false,
      pin: null,
      hit: null,
      basemapWords: [],
      location: null,
      lookup: { ...IDLE },
      change: { ...IDLE_CHANGE },
      sample: { ...IDLE_SAMPLE },
    });
  },

  setBasemapWords: (words) => set({ basemapWords: words }),

  lookupPlace: () => {
    const { pin, lookup } = get();
    if (!pin || lookup.status === "loading") return;
    seq += 1;
    const mySeq = seq;
    lookupController?.abort();
    const controller = new AbortController();
    lookupController = controller;
    set({ lookup: { status: "loading", name: null, error: null } });
    void (async () => {
      try {
        const name = await reversePlace(pin[0], pin[1], { signal: controller.signal });
        if (seq !== mySeq) return;
        set({ lookup: { status: "done", name, error: null } });
      } catch (error) {
        if (seq !== mySeq || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Place lookup failed.";
        set({ lookup: { status: "error", name: null, error: message } });
      } finally {
        if (lookupController === controller) lookupController = null;
      }
    })();
  },

  sampleNdvi: (scene) => {
    const { pin, sample } = get();
    if (!pin || sample.status === "loading") return;
    seq += 1;
    const mySeq = seq;
    sampleController?.abort();
    const controller = new AbortController();
    sampleController = controller;
    set({ sample: { status: "loading", info: null, error: null } });
    void (async () => {
      try {
        const response = await fetch("/api/imagery/sample", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ date: scene.date, composite: scene.composite, lng: pin[0], lat: pin[1] }),
        });
        if (!response.ok) throw new Error(await readError(response, "NDVI sample failed"));
        const info = (await response.json()) as SampleInfo;
        if (seq !== mySeq) return;
        set({ sample: { status: "done", info, error: null } });
      } catch (error) {
        if (seq !== mySeq || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "NDVI sample failed.";
        set({ sample: { status: "error", info: null, error: message } });
      } finally {
        if (sampleController === controller) sampleController = null;
      }
    })();
  },

  selectAdminArea: (level) => {
    const pin = get().pin;
    if (!pin) return false;
    const admin = pipAdmin(pin[0], pin[1]);
    const app = useAppStore.getState();

    if (level === "district") {
      if (!admin.district) return false;
      const bbox = bboxFromGeometry(admin.district.geometry);
      if (!bbox) return false;
      const district: District = {
        id: admin.district.id,
        name: admin.district.name,
        geometry: admin.district.geometry,
        bbox,
      };
      app.setDistrict(district);
      return true;
    }

    if (!admin.tehsil) return false;
    const tehsilBbox = bboxFromGeometry(admin.tehsil.geometry);
    if (!tehsilBbox) return false;
    if (admin.district) {
      const districtBbox = bboxFromGeometry(admin.district.geometry);
      if (districtBbox) {
        app.setDistrict({
          id: admin.district.id,
          name: admin.district.name,
          geometry: admin.district.geometry,
          bbox: districtBbox,
        });
      }
    }
    const tehsil: Tehsil = {
      id: admin.tehsil.id,
      name: admin.tehsil.name,
      districtId: admin.tehsil.districtId ?? admin.district?.id ?? "",
      geometry: admin.tehsil.geometry,
      bbox: tehsilBbox,
    };
    app.setTehsil(tehsil);
    return true;
  },
}));

/**
 * The Change section belongs to one comparison result: when it is replaced
 * or cleared while the card is open, close the card rather than showing
 * class/patch data from a run that no longer exists.
 */
useCompareStore.subscribe((state, previous) => {
  if (!previous.result) return;
  if (state.result?.key === previous.result.key) return;
  const inspector = useInspectorStore.getState();
  if (inspector.open) inspector.close();
});
