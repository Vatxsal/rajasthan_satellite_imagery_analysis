import { NOMINATIM_REVERSE_URL } from "@/lib/map/constants";

/**
 * On-demand reverse geocoding for the inspector's Satellite-mode location
 * section. Streets mode never calls this — it describes the rendered basemap
 * features locally. Policy: cached per ~100 m cell, at most one request per
 * second, aborted with the caller on stale pin moves.
 */

interface NominatimReverse {
  display_name?: string;
}

const cache = new Map<string, string>();
let lastRequestAt = 0;

function cacheKey(lng: number, lat: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** "Sanganer, Jaipur, Rajasthan" — first three comma parts, enough for a row. */
function shortenDisplayName(displayName: string): string {
  return displayName
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
}

export async function reversePlace(
  lng: number,
  lat: number,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const key = cacheKey(lng, lat);
  const cached = cache.get(key);
  if (cached) return cached;

  const waitMs = lastRequestAt + 1000 - Date.now();
  if (waitMs > 0) await sleep(waitMs, options.signal);
  lastRequestAt = Date.now();

  const url = `${NOMINATIM_REVERSE_URL}?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(
    String(lng),
  )}&format=jsonv2&zoom=10&addressdetails=0`;
  const response = await fetch(url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Place lookup failed (HTTP ${response.status}).`);
  const body = (await response.json()) as NominatimReverse;
  const name = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!name) throw new Error("No place name found for this point.");
  const short = shortenDisplayName(name);
  cache.set(key, short);
  return short;
}

/** Test hook — clears the reverse-geocode cache and rate-limit clock. */
export function resetNominatimState(): void {
  cache.clear();
  lastRequestAt = 0;
}
