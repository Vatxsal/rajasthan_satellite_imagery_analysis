/**
 * Dev-only tile fetch instrumentation for the Swipe debug badge.
 *
 * Patches window.fetch once (development builds only) and tallies
 * /api/tiles responses per date: ok / skipped (x-tile-skip header) /
 * rate-limited (429) / failed. Never throws — instrumentation must not
 * affect the requests it observes.
 */

export interface TileCount {
  ok: number;
  skip: number;
  limited: number;
  fail: number;
}

/** date → tally. */
export type TileTally = Record<string, TileCount>;

export function emptyTileCount(): TileCount {
  return { ok: 0, skip: 0, limited: 0, fail: 0 };
}

/** Classify one tile response into a tally bucket. */
export function classifyTileResponse(
  status: number,
  skipHeader: string | null,
): keyof TileCount {
  if (status === 429) return "limited";
  if (status >= 400) return "fail";
  if (skipHeader) return "skip";
  return "ok";
}

/** Pure reducer: returns a new tally with one more response counted. */
export function addTileResponse(
  tally: TileTally,
  date: string,
  status: number,
  skipHeader: string | null,
): TileTally {
  const bucket = tally[date] ?? emptyTileCount();
  const key = classifyTileResponse(status, skipHeader);
  return { ...tally, [date]: { ...bucket, [key]: bucket[key] + 1 } };
}

let counts: TileTally = {};
const listeners = new Set<() => void>();
let installed = false;

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Idempotent: wraps window.fetch once, in development builds only. */
export function installTileDebug(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV === "production") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    original(input, init).then((response) => {
      try {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (raw.includes("/api/tiles/")) {
          const url = new URL(raw, window.location.href);
          const date = url.searchParams.get("date") ?? "?";
          counts = addTileResponse(counts, date, response.status, response.headers.get("x-tile-skip"));
          notify();
        }
      } catch {
        // Instrumentation never breaks a tile request.
      }
      return response;
    });
}

export function subscribeTileDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTileTally(): TileTally {
  return counts;
}

export function resetTileTally(): void {
  counts = {};
  notify();
}
