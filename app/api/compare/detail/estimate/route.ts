import { NextResponse } from "next/server";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import { authorize, forbiddenRoleResponse } from "@/lib/auth/guard";
import { can, clampCompareTuning } from "@/lib/auth/permissions";
import { dataSource } from "@/lib/env";
import {
  compareParamsSchema,
  MOCK_SOURCE_MESSAGE,
  resolveCompareParams,
} from "@/lib/server/compareRun";
import { estimateDetail } from "@/lib/server/detailRun";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/compare/detail/estimate
 *
 * Body: the analyze parameter set with detail=detailed|smart. Answers the
 * cost card the client shows before the confirm dialog:
 *   { detail, blocksTotal, blocksSelected, screeningPu, blocksPu,
 *     estimatedPu, cap, overQuickLimit }
 *
 * Smart estimates run the coarse screening pass (~40 m) when it is not
 * cached yet — the subsequent analyze reuses it, so the cost is paid once.
 * No daily quota is consumed (the compare rate limit still applies; the
 * screening render bills the render budget like any fetch).
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "compare");
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await readJsonBody(request, (raw) => compareParamsSchema.parse(raw));
    if (body.detail === "quick") {
      throw apiError(
        400,
        "INVALID_REQUEST",
        "detail must be detailed or smart for an estimate.",
      );
    }
    if (!can(auth.role, "compare.detailed")) return forbiddenRoleResponse("compare.detailed");
    if (dataSource === "mock") {
      throw apiError(400, "CDSE_CONFIG", MOCK_SOURCE_MESSAGE);
    }
    const tuned = clampCompareTuning(auth.role, body);
    const resolved = resolveCompareParams(tuned, { role: auth.role });
    const estimate = await estimateDetail(resolved);
    return NextResponse.json(estimate, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
