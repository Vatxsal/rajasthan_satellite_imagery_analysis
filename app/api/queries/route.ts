import { NextResponse } from "next/server";
import { z } from "zod";
import { forbiddenRoleResponse } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { errorResponse, readJsonBody, sameOriginGuard } from "@/lib/server/api";
import {
  MAX_QUERY_BODY_BYTES,
  assertAreaExists,
  nameTakenResponse,
  queriesContext,
  repoErrorResponse,
} from "@/lib/server/queries";
import { isQueryRepoError, savedQueryInputSchema } from "@/lib/queries/repository";

export const runtime = "nodejs";

/** Lists the caller's saved queries (owner = session subject, never a param). */
export async function GET(request: Request): Promise<NextResponse> {
  const context = await queriesContext(request);
  if (context instanceof NextResponse) return context;
  try {
    const queries = await context.repo.list();
    return NextResponse.json({ queries }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repoErrorResponse(error) ?? errorResponse(error);
  }
}

/** Creates one saved query — strict schema, existing area, role cap. */
export async function POST(request: Request): Promise<NextResponse> {
  const crossOrigin = sameOriginGuard(request);
  if (crossOrigin) return crossOrigin;

  const context = await queriesContext(request);
  if (context instanceof NextResponse) return context;

  let body: z.output<typeof savedQueryInputSchema>;
  try {
    body = await readJsonBody(
      request,
      (raw) => savedQueryInputSchema.parse(raw),
      MAX_QUERY_BODY_BYTES,
    );
  } catch (error) {
    return errorResponse(error);
  }

  // Compare tuning is an SSO-held capability — policy may narrow it later.
  if (body.compare != null && !can(context.auth.role, "compare.adjust-sensitivity")) {
    return forbiddenRoleResponse("compare.adjust-sensitivity");
  }
  try {
    assertAreaExists(body.area);
  } catch (error) {
    return errorResponse(error);
  }

  try {
    const query = await context.repo.create(body);
    return NextResponse.json({ query }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isQueryRepoError(error) && error.code === "NAME_TAKEN") {
      return nameTakenResponse(context.repo, body.name);
    }
    return repoErrorResponse(error) ?? errorResponse(error);
  }
}
