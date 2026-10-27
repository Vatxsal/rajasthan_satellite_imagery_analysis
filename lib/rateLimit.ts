import { getServerEnv } from "@/lib/env";

interface Bucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;

/** Which rate-limit bucket a request consumes. */
export type RateLimitKind = "api" | "tiles" | "compare" | "ai";

const buckets: Record<RateLimitKind, Map<string, Bucket>> = {
  api: new Map(),
  tiles: new Map(),
  compare: new Map(),
  ai: new Map(),
};

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "local";
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

/** Simple fixed-window per-IP rate limiter with a separate window per bucket. */
export function checkRateLimit(request: Request, kind: RateLimitKind = "api"): RateLimitResult {
  const env = getServerEnv();
  const limit =
    kind === "tiles"
      ? env.RATE_LIMIT_TILES_PER_MIN
      : kind === "compare"
        ? env.COMPARE_RATE_LIMIT_PER_MIN
        : kind === "ai"
          ? env.AI_SUMMARY_RATE_LIMIT_PER_MIN
          : env.RATE_LIMIT_PER_MIN;
  const map = buckets[kind];
  const key = getClientIp(request);
  const now = Date.now();

  if (map.size > 2_000) {
    map.forEach((bucket, mapKey) => {
      if (bucket.resetAt <= now) map.delete(mapKey);
    });
  }

  const bucket = map.get(key);
  if (!bucket || bucket.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
}
