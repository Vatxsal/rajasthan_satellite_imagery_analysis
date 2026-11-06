"use client";

/**
 * Opens an emailed report link (/?a=&l=&A=&B=&s=&m=&im=&tab=&e=) exactly the
 * way a user would: validate everything first, select the area, search the
 * pair's scenes, arm compare, run the stateless recompute, then land on the
 * requested tab and focus the linked event. Nothing unvalidated ever reaches
 * the store, and a tampered link is ignored with a toast.
 *
 * Mounts once from app/page.tsx and renders nothing.
 */
import { useEffect } from "react";
import { focusHotspot, getMainMap } from "@/lib/compare/bridge";
import { selectVisibleEvents } from "@/lib/compare/eventList";
import { parseShareLink, type ShareLink } from "@/lib/compare/shareLink";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { dataSource } from "@/lib/dataSource";
import type { District, Ilr, Tehsil } from "@/lib/data";
import { districtsFc, ilrsFc, tehsilsFc } from "@/lib/data/boundaries";
import { useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";

/** One attempt per page load (guards effect re-runs under StrictMode/HMR). */
let processed = false;

interface ResolvedShareArea {
  district: District | null;
  tehsil: Tehsil | null;
  ilr: Ilr | null;
}

function polygonOf(feature: GeoJSON.Feature): GeoJSON.Polygon | null {
  const geometry = feature.geometry;
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) return null;
  // Same cast the server's resolveArea uses — AreaSelection is Polygon-typed.
  return geometry as GeoJSON.Polygon;
}

function districtById(id: string): District | null {
  const feature = districtsFc.features.find((candidate) => candidate.properties?.id === id);
  if (!feature) return null;
  const geometry = polygonOf(feature);
  const bbox = geometry ? bboxFromGeometry(geometry) : null;
  if (!geometry || !bbox) return null;
  return {
    id: String(feature.properties?.id ?? id),
    name: String(feature.properties?.name ?? id),
    geometry,
    bbox,
  };
}

function tehsilById(id: string): Tehsil | null {
  const feature = tehsilsFc.features.find((candidate) => candidate.properties?.id === id);
  if (!feature) return null;
  const geometry = polygonOf(feature);
  const bbox = geometry ? bboxFromGeometry(geometry) : null;
  if (!geometry || !bbox) return null;
  return {
    id: String(feature.properties?.id ?? id),
    name: String(feature.properties?.name ?? id),
    districtId: String(feature.properties?.districtId ?? ""),
    geometry,
    bbox,
  };
}

function ilrById(id: string): Ilr | null {
  const feature = ilrsFc.features.find((candidate) => candidate.properties?.id === id);
  if (!feature) return null;
  const geometry = polygonOf(feature);
  const bbox = geometry ? bboxFromGeometry(geometry) : null;
  if (!geometry || !bbox) return null;
  return {
    id: String(feature.properties?.id ?? id),
    name: String(feature.properties?.name ?? id),
    tehsilId: String(feature.properties?.tehsilId ?? ""),
    districtId: String(feature.properties?.districtId ?? ""),
    geometry,
    bbox,
  };
}

/** Leaf area must exist; parents are best-effort (the setters chain cleanly). */
function resolveShareArea(link: ShareLink): ResolvedShareArea | null {
  if (link.level === "district") {
    const district = districtById(link.areaId);
    return district ? { district, tehsil: null, ilr: null } : null;
  }
  if (link.level === "tehsil") {
    const tehsil = tehsilById(link.areaId);
    if (!tehsil) return null;
    return { district: districtById(tehsil.districtId), tehsil, ilr: null };
  }
  const ilr = ilrById(link.areaId);
  if (!ilr) return null;
  const tehsil = ilr.tehsilId ? tehsilById(ilr.tehsilId) : null;
  return {
    district: districtById(ilr.districtId || tehsil?.districtId || ""),
    tehsil,
    ilr,
  };
}

/** Drops report params from the address bar after a rejected link. */
function stripShareParams(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
}

function rejectLink(message: string): void {
  useAppStore.getState().pushToast({ tone: "error", message, duration: 8000 });
  stripShareParams();
}

/** Finds the linked event in the visible list and frames it like a row click. */
async function focusEventById(eventId: string): Promise<void> {
  const state = useCompareStore.getState();
  const visible = selectVisibleEvents(state.eventsItems, {
    confidenceFilter: state.confidenceFilter,
    limit: state.eventsLimit,
  });
  const index = visible.findIndex(
    (feature) =>
      String(feature.id ?? (feature.properties as { id?: unknown } | undefined)?.id ?? "") ===
      eventId,
  );
  if (index < 0) {
    useAppStore.getState().pushToast({
      tone: "info",
      message: "The linked change event isn't part of this result.",
      duration: 6000,
    });
    return;
  }

  const feature = visible[index]!;
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const centroid = (props.centroid as number[] | undefined) ?? [0, 0];
  const bboxProps = props.bbox as number[] | undefined;
  // Same focus-bbox rule the Events list rows use.
  const bbox: [number, number, number, number] =
    bboxProps && bboxProps.length === 4
      ? [bboxProps[0], bboxProps[1], bboxProps[2], bboxProps[3]]
      : [centroid[0] - 0.002, centroid[1] - 0.002, centroid[0] + 0.002, centroid[1] + 0.002];

  // The popup needs the registered map instance (mounts with the page —
  // normally ready long before an analysis finishes).
  for (let attempt = 0; attempt < 20 && !getMainMap(); attempt++) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  focusHotspot(index + 1, bbox);
}

async function openFromShareLink(): Promise<void> {
  const search = window.location.search;
  if (!new URLSearchParams(search).has("a")) return; // plain visit
  if (dataSource !== "cdse") return; // demo mode: report links don't apply

  const link = parseShareLink(search);
  if (!link) {
    rejectLink("This report link is incomplete or invalid.");
    return;
  }
  const area = resolveShareArea(link);
  if (!area) {
    rejectLink("This report link points to an area that is no longer available.");
    return;
  }

  // 1. Area selection — parents first (each setter clears deeper levels).
  const app = useAppStore.getState();
  if (area.district) app.setDistrict(area.district);
  if (area.tehsil) app.setTehsil(area.tehsil);
  if (area.ilr) app.setIlr(area.ilr);

  // 2. Scenes for the pair: gives the strip its cards AND the live "Analyzing…"
  //    progress UI (CompareBar renders only after a search). A failed search
  //    still proceeds — the server does its own catalogue lookup.
  const filters = useAppStore.getState();
  filters.setFromDate(link.dateA);
  filters.setToDate(link.dateB);
  filters.setMaxCloudCover(100); // the analysis validates scenes at maxCloud 100
  await useAppStore.getState().runSearch();

  // 3. Arm compare, apply settings, set the pair (A = earlier is normalised
  //    inside run() — the store keeps the raw order like a user pick would).
  const compare = useCompareStore.getState();
  if (!compare.compareMode) compare.toggleCompareMode();
  compare.setSensitivity(link.sensitivity);
  compare.setMinPatchHa(link.minPatchHa);
  compare.setInputMode(link.inputMode);
  useCompareStore.setState({ dateA: link.dateA, dateB: link.dateB });

  // 4. Stateless recompute — cache hit is instant, a cold cache re-runs.
  await useCompareStore.getState().run();
  const after = useCompareStore.getState();
  if (!after.result) return; // run() already surfaced the error as a toast

  // 5. Landing state: requested tab, report banner, then the event focus.
  after.setTab(link.tab);
  after.markShareOpened();
  if (link.eventId) await focusEventById(link.eventId);
}

export default function ShareLinkLoader() {
  useEffect(() => {
    if (processed) return;
    processed = true;
    void openFromShareLink();
  }, []);
  return null;
}
