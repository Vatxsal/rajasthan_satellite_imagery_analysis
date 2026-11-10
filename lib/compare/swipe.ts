/**
 * Pure helpers for the Swipe tab (two clean secondary maps, no overlay).
 * Zero value imports — node-testable from scripts/swipe.test.ts.
 */

/**
 * A is always the earlier date, B the later one (ISO yyyy-mm-dd sorts
 * chronologically). Reversed picks are swapped so the A/B labels, the
 * analysis request and the drawer header all agree.
 */
export function normalizeComparePair(
  dateA: string | null,
  dateB: string | null,
): { dateA: string | null; dateB: string | null } {
  if (!dateA || !dateB || dateA <= dateB) return { dateA, dateB };
  return { dateA: dateB, dateB: dateA };
}

/** CSS clip-path insets hiding each secondary-map half behind the divider. */
export function swipeClipPath(divider: number, side: "left" | "right"): string {
  const value = Math.min(100, Math.max(0, Math.round(divider * 1000) / 1000));
  return side === "left"
    ? `inset(0 ${round(100 - value)}% 0 0)`
    : `inset(0 0 0 ${round(value)}%)`;
}

/** Attribution line for the swipe maps (both dates + the basemap). */
export function swipeAttribution(dates: {
  dateA: string | null;
  dateB: string | null;
  /** "basemap" swaps date B's Sentinel credit for the Esri imagery credit. */
  mode?: "dates" | "basemap";
}): string {
  const years = new Set<string>();
  if (dates.dateA) years.add(dates.dateA.slice(0, 4));
  if (dates.mode !== "basemap" && dates.dateB) years.add(dates.dateB.slice(0, 4));
  const sentinels = Array.from(years).sort().join(", ") || "—";
  const tail =
    dates.mode === "basemap"
      ? "Imagery © Esri, Maxar, Earthstar Geographics · © OpenStreetMap contributors"
      : "© OpenStreetMap contributors";
  return `Contains modified Copernicus Sentinel data ${sentinels} · ${tail}`;
}

/** Trim trailing zeros so clip values read "50%" not "50.000%". */
function round(value: number): string {
  return Number(value.toFixed(3)).toString();
}
