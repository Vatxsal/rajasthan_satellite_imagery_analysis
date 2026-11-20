/**
 * Display formatting driven by the "Units and format" preferences.
 * Everything the UI shows goes through here so one preference change updates
 * every panel; exports/emails keep canonical units (ha, UTC, DD) and state
 * those units in their headers instead.
 */

export type AreaUnit = "ha" | "km2" | "acre";
export type CoordinateFormat = "dd" | "dms";
export type TimeZoneId = "ist" | "utc";
export type DateFormatId = "dd-mm-yyyy" | "yyyy-mm-dd" | "dd-mon-yyyy";

export const TIME_ZONE_IDS: Record<TimeZoneId, string> = {
  ist: "Asia/Kolkata",
  utc: "UTC",
};

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Hectares → the preferred unit with a localised number:
 *   ha → "1,234.5 ha" (default) · km2 → "12.35 km²" · acre → "3,050.1 ac".
 * `maximumFractionDigits` overrides the per-unit default (the analysed-area
 * row keeps its whole-hectares spec formatting with 0).
 */
export function formatArea(
  hectares: number,
  unit: AreaUnit = "ha",
  opts: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(hectares)) return "—";
  const value = unit === "km2" ? hectares / 100 : unit === "acre" ? hectares * 2.471053814671653 : hectares;
  const suffix = unit === "km2" ? "km²" : unit === "acre" ? "ac" : "ha";
  const maximumFractionDigits = opts.maximumFractionDigits ?? (unit === "km2" ? 2 : 1);
  return `${value.toLocaleString("en", { maximumFractionDigits })} ${suffix}`;
}

/** Metres → "842 m" / "1,234 m" / "3.18 km" (no length unit preference exists). */
export function formatLength(metres: number): string {
  if (!Number.isFinite(metres)) return "—";
  if (metres < 1000) return `${Math.round(metres).toLocaleString("en")} m`;
  return `${(metres / 1000).toLocaleString("en", { maximumFractionDigits: 2 })} km`;
}

function toDms(value: number, positive: string, negative: string): string {
  const hemisphere = value >= 0 ? positive : negative;
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minuteFloat = (abs - degrees) * 60;
  const minutes = Math.floor(minuteFloat);
  const seconds = (minuteFloat - minutes) * 60;
  return `${degrees}° ${minutes}' ${seconds.toFixed(1)}" ${hemisphere}`;
}

/** "17.1234° N  75.1234° E" (DD) or "17° 7' 24.2\" N  75° 7' 24.2\" E" (DMS). */
export function formatCoords(lng: number, lat: number, format: CoordinateFormat = "dd"): string {
  if (format === "dms") return `${toDms(lat, "N", "S")}  ${toDms(lng, "E", "W")}`;
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}  ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? "E" : "W"}`;
}

/** ISO day ("2026-01-05") → the preferred date format. */
export function formatDate(iso: string, format: DateFormatId = "dd-mon-yyyy"): string {
  const [year, month, day] = iso.split("-");
  if (!year || !month || !day || year.length !== 4 || month.length !== 2) return iso;
  if (format === "yyyy-mm-dd") return iso;
  if (format === "dd-mm-yyyy") return `${day}-${month}-${year}`;
  const monthName = MONTHS_SHORT[Number(month) - 1] ?? month;
  return `${day} ${monthName} ${year}`; // "05 Jan 2026" — same shape as the old card formatter
}

/** Epoch seconds → "15 Nov 2026, 18:30 IST" (dateOnly → "15 Nov 2026"). */
export function formatDateTime(
  epochSeconds: number,
  opts: { timeZone?: TimeZoneId; dateOnly?: boolean } = {},
): string {
  const timeZone = TIME_ZONE_IDS[opts.timeZone ?? "ist"];
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(opts.dateOnly
      ? {}
      : {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZoneName: "short" as const,
        }),
  });
  return formatter.format(new Date(epochSeconds * 1000));
}
