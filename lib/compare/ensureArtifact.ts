/**
 * Cache-first artifact access with stateless recompute on a miss — the one
 * behaviour every cache-backed compare route (events / overlay / summary)
 * shares so a cold server cache re-runs the analysis instead of answering
 * 404 "expired" while the client still holds the result.
 *
 * Pure: the cache, the in-flight map and the compute function are injected,
 * so the hit/miss/dedupe/failure contract is unit-testable without CDSE.
 */
export interface ArtifactCacheLike<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlSeconds: number): void;
}

export interface EnsureCachedOptions<T> {
  /** Shared map of in-flight recomputes — concurrent callers of one key
   *  (restart + Load more + a summary probe) share a single run. */
  inflight?: Map<string, Promise<T>>;
  /** TTL for a freshly computed value; omitted → the cache keeps it default. */
  ttlSeconds?: number;
}

export interface EnsureCachedResult<T> {
  value: T;
  /** True only for a stored value — a recompute (own or joined) is a miss. */
  hit: boolean;
}

export async function ensureCached<T>(
  cache: ArtifactCacheLike<T>,
  key: string,
  run: () => Promise<T>,
  options: EnsureCachedOptions<T> = {},
): Promise<EnsureCachedResult<T>> {
  const cached = cache.get(key);
  if (cached !== undefined) return { value: cached, hit: true };

  const inflight = options.inflight;
  const pending = inflight?.get(key);
  if (pending) return { value: await pending, hit: false };

  const promise = run();
  inflight?.set(key, promise);
  try {
    const value = await promise;
    if (options.ttlSeconds !== undefined) cache.set(key, value, options.ttlSeconds);
    return { value, hit: false };
  } finally {
    inflight?.delete(key);
  }
}
