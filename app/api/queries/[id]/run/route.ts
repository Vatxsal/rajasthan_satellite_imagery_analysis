import { NextResponse } from "next/server";
import { errorResponse, jsonError, sameOriginGuard } from "@/lib/server/api";
import { queriesContext, repoErrorResponse } from "@/lib/server/queries";

export const runtime = "nodejs";

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Records a run of one saved query (lastRunAt + runCount++). No body: the
 * query already stores its own filters; the client applies them to the app
 * state itself and the run stat is bookkeeping only.
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const crossOrigin = sameOriginGuard(request);
  if (crossOrigin) return crossOrigin;

  const context = await queriesContext(request);
  if (context instanceof NextResponse) return context;
  if (!ID_RE.test(params.id)) return jsonError(404, "NOT_FOUND", "Saved query not found.");

  try {
    const query = await context.repo.touchRun(params.id);
    if (!query) return jsonError(404, "NOT_FOUND", "Saved query not found.");
    return NextResponse.json({ query }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repoErrorResponse(error) ?? errorResponse(error);
  }
}
