import { NextResponse } from "next/server";
import { z } from "zod";
import { authorize, forbiddenRoleResponse, consumeRoleQuota } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { probeCache, probeCacheKey } from "@/lib/cache";
import { resolveCompareParams } from "@/lib/server/compareRun";
import { runProbe } from "@/lib/server/probeRun";
import { apiError, errorResponse, rateLimitGuard, sameOriginGuard } from "@/lib/server/api";
import { getServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

const pointSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/**
 * POST /api/compare/probe { lng, lat, …analysis params }
 *
 * Phase 4 "why is this spot changed/unchanged?": classifies a ~480 m
 * native-10 m window around the point with the request's sensitivity and
 * minimum-patch settings and answers one of:
 *   kept | below-mmu | sub-threshold | no-change | masked
 * with the Δ-index values, the applied thresholds and the patch size — the
 * client turns those into the "Re-run with higher sensitivity / smaller
 * patches" actions.
 *
 * Metered like the NDVI sample (inspectSample quota): one probe = one small
 * Process render pair. Verdicts are cached per point (~100 m rounding) so
 * repeat clicks and re-opens are free.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "compare");
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  if (!can(auth.role, "inspect.basic")) return forbiddenRoleResponse("inspect.basic");

  try {
    const raw: unknown = await request.json().catch(() => null);
    const point = pointSchema.parse(raw);

    // Daily sample quota (per session AND per IP) — consumed after the body
    // parses, before any resolve work (same fail-fast order as analyze).
    const quotaDenied = consumeRoleQuota(auth, "inspectSample");
    if (quotaDenied) return quotaDenied;

    // The analysis params (areaId/level/dates/tuning) ride in the same body;
    // resolveCompareParams strips the extra point keys (and throws the mock/
    // CDSE_CONFIG guard itself).
    const resolved = resolveCompareParams(raw, { role: auth.role });

    // The probe window must sit inside the selected area's bbox — probing
    // outside the AOI would answer for pixels the analysis never covers.
    const [west, south, east, north] = resolved.area.bbox;
    if (
      point.lng < west ||
      point.lng > east ||
      point.lat < south ||
      point.lat > north
    ) {
      throw apiError(
        400,
        "PROBE_OUTSIDE",
        "Probe a point inside the selected area.",
      );
    }

    // Daily NDVI/sample quota (per session AND per IP) — one small render pair.
    // (Consumed above, right after the body parsed.)

    const cacheKey = probeCacheKey(resolved.key, point.lng, point.lat);
    const cached = probeCache.get(cacheKey);
    if (cached) {
      return NextResponse.json(cached, { headers: { "Cache-Control": "no-store" } });
    }

    const result = await runProbe(resolved, point.lng, point.lat);
    probeCache.set(cacheKey, result, getServerEnv().IMAGERY_CACHE_TTL_SECONDS);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
