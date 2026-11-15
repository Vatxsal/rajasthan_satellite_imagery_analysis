/** Shared date-range presets: the FiltersPanel buttons and the home reset
 *  reapply the same window, so the day counts live in one place. */
export type DateRangePresetId = "30d" | "90d" | "6m";

export const DATE_RANGE_DAYS: Record<DateRangePresetId, number> = {
  "30d": 30,
  "90d": 90,
  "6m": 182,
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** from/to ISO days for a preset, anchored on `today` (defaults to now, UTC). */
export function rangeToDates(
  range: DateRangePresetId,
  today: Date = new Date(),
): { from: string; to: string } {
  const from = new Date(today);
  from.setDate(from.getDate() - DATE_RANGE_DAYS[range]);
  return { from: isoDay(from), to: isoDay(today) };
}
