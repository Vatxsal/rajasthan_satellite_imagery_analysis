import { NextResponse } from "next/server";
import { z } from "zod";
import { forbiddenRoleResponse } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { errorResponse, jsonError, readJsonBody, sameOriginGuard } from "@/lib/server/api";
import {
  MAX_QUERY_BODY_BYTES,
  assertAreaExists,
  nameTakenResponse,
  queriesContext,
  repoErrorResponse,
} from "@/lib/server/queries";
import { isQueryRepoError, savedQueryPatchSchema } from "@/lib/queries/repository";

export const runtime = "nodejs";

/** uuid-shaped ids only — anything else is simply "not found" (no probing signal). */
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function idOrNotFound(id: string): NextResponse | null {
  if (!ID_RE.test(id)) return jsonError(404, "NOT_FOUND", "Saved query not found.");
  return null;
}

/** Partial update (rename, pin, edit filters) — unknown rows answer 404. */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const crossOrigin = sameOriginGuard(request);
  if (crossOrigin) return crossOrigin;

  const context = await queriesContext(request);
  if (context instanceof NextResponse) return context;
  const missing = idOrNotFound(params.id);
  if (missing) return missing;

  let patch: z.output<typeof savedQueryPatchSchema>;
  try {
    patch = await readJsonBody(
      request,
      (raw) => savedQueryPatchSchema.parse(raw),
      MAX_QUERY_BODY_BYTES,
    );
  } catch (error) {
    return errorResponse(error);
  }

  if (patch.compare != null && !can(context.auth.role, "compare.adjust-sensitivity")) {
    return forbiddenRoleResponse("compare.adjust-sensitivity");
  }
  if (patch.area !== undefined) {
    try {
      assertAreaExists(patch.area);
    } catch (error) {
      return errorResponse(error);
    }
  }

  try {
    const query = await context.repo.update(params.id, patch);
    if (!query) return jsonError(404, "NOT_FOUND", "Saved query not found.");
    return NextResponse.json({ query }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isQueryRepoError(error) && error.code === "NAME_TAKEN") {
      return nameTakenResponse(context.repo, patch.name ?? "");
    }
    return repoErrorResponse(error) ?? errorResponse(error);
  }
}

/** Deletes one saved query; the second delete of the same id answers 404. */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const crossOrigin = sameOriginGuard(request);
  if (crossOrigin) return crossOrigin;

  const context = await queriesContext(request);
  if (context instanceof NextResponse) return context;
  const missing = idOrNotFound(params.id);
  if (missing) return missing;

  try {
    const deleted = await context.repo.delete(params.id);
    if (!deleted) return jsonError(404, "NOT_FOUND", "Saved query not found.");
    return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repoErrorResponse(error) ?? errorResponse(error);
  }
}
