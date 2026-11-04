/**
 * Single source of truth for the Events list AND the map markers.
 *
 * The list rows and the numbered map markers/polygons are both derived from
 * this module over the same `eventsItems` array (inline from the analyze
 * response, extended by server pages) — so list rank N and marker rank N are
 * the same feature by construction, whatever the confidence filter or the
 * client-side page cursor is doing.
 */
import type { ConfidenceTier } from "@/lib/analysis/types";

export type CompareEventsStatus = "idle" | "loading" | "ready" | "error";

/** Tier ranks for the minimum-confidence filter (low ≤ medium ≤ high). */
const CONFIDENCE_RANK: Record<ConfidenceTier, number> = { low: 1, medium: 2, high: 3 };

/**
 * Confidence filter over a raw (unfiltered) events array; null = keep all.
 * MINIMUM semantics — "medium" keeps medium + high — matching the server's
 * `confidence` query param (pageEvents) and the probe totals, so the visible
 * rows always agree with the header count.
 */
export function filterEvents(
  features: GeoJSON.Feature[],
  confidenceFilter: ConfidenceTier | null,
): GeoJSON.Feature[] {
  if (!confidenceFilter) return features;
  const min = CONFIDENCE_RANK[confidenceFilter];
  return features.filter((feature) => {
    const props = feature.properties as Record<string, unknown> | undefined;
    const tier = props?.confidence as ConfidenceTier | undefined;
    const rank = tier ? CONFIDENCE_RANK[tier] : undefined;
    return rank !== undefined && rank >= min;
  });
}

export interface SelectVisibleOptions {
  confidenceFilter: ConfidenceTier | null;
  /** Client page cursor — how many rows the list shows (and how many markers exist). */
  limit: number;
}

/**
 * What the list renders and what the map numbers: filtered, largest-first,
 * capped at the cursor. Deterministic — the same inputs always yield the same
 * rows in the same order (used by tests to assert list ↔ marker parity).
 */
export function selectVisibleEvents(
  features: GeoJSON.Feature[],
  options: SelectVisibleOptions,
): GeoJSON.Feature[] {
  return filterEvents(features, options.confidenceFilter).slice(0, Math.max(0, options.limit));
}

/** Marker rows are the visible list rows — kept as a named step for clarity. */
export function eventMarkerRows(
  features: GeoJSON.Feature[],
  options: SelectVisibleOptions,
): GeoJSON.Feature[] {
  return selectVisibleEvents(features, options);
}

export type EventsViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "list" };

/**
 * Pure view decision for the Events tab. Rules that fix the reported bug:
 *  - "list" only ever implies at least one visible row, so a failed fetch can
 *    no longer show the header with "Change events — 0 patches";
 *  - an error with nothing loaded renders the error state (banner only — no
 *    header, no skeleton pretending to be data);
 *  - rows that are already loaded always win: a failed Load-more keeps the
 *    list (the tab shows the retry banner alongside it);
 *  - a genuine zero (ready, no matching rows) is the empty state.
 */
export function eventsViewState(input: {
  status: CompareEventsStatus;
  error?: string | null;
  visibleCount: number;
}): EventsViewState {
  if (input.visibleCount > 0) return { kind: "list" };
  const message = (input.error ?? "").trim();
  if (input.status === "error") {
    return { kind: "error", message: message || "Change events failed to load." };
  }
  if (input.status === "ready") return { kind: "empty" };
  return { kind: "loading" };
}
