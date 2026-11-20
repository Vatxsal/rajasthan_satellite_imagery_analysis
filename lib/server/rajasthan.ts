/**
 * Server-side Rajasthan outline for shape validation.
 *
 * The client fetches /data/state-outline.geojson once (relative URL — a
 * server fetch has no origin to resolve it against); the server imports the
 * same bundled file so the inside-Rajasthan rule is always enforced here
 * instead of failing open like the client's fetch path does.
 */
import rawOutline from "@/public/data/state-outline.geojson";
import { loadRajasthanOutlineFrom, type RajasthanOutline } from "@/lib/draw/geometry";

let cached: RajasthanOutline | null | undefined;

export function serverRajasthanOutline(): RajasthanOutline | null {
  if (cached === undefined) cached = loadRajasthanOutlineFrom(rawOutline as unknown);
  return cached;
}
