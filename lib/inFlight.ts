/**
 * Named AbortControllers for in-flight UI requests so a home reset (or a
 * superseding run) can cancel them. Each key holds at most one controller:
 * beginning a new request aborts the previous one for that key.
 * Nothing here touches the network directly — callers pass the signal.
 */
const controllers = new Map<string, AbortController>();

/** Keys used by the app; resetToHome aborts all of them. */
export const IN_FLIGHT = {
  search: "search",
  summary: "summary",
  email: "email",
} as const;

/** Abort the previous request for `key` and register a fresh controller. */
export function beginInFlight(key: string): AbortController {
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);
  return controller;
}

/** Abort and drop the controller registered under `key` (no-op if none). */
export function abortInFlight(key: string): void {
  const controller = controllers.get(key);
  if (!controller) return;
  controller.abort();
  controllers.delete(key);
}

/** Abort a whole set of keys (home reset). */
export function abortInFlightAll(keys: readonly string[]): void {
  for (const key of keys) abortInFlight(key);
}

/** Live signal for `key` (null when nothing is in flight). */
export function inFlightSignal(key: string): AbortSignal | null {
  return controllers.get(key)?.signal ?? null;
}
