import { NextResponse } from "next/server";
import { getTokenHealth } from "@/lib/cdse/auth";
import { hasWmtsInstance } from "@/lib/cdse/wmts";
import { dataSource, getServerEnv } from "@/lib/env";
import { errorResponse, rateLimitGuard } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/health/cdse — quick connectivity check for the live catalogue.
 * Reports whether credentials are present and whether a token can be obtained.
 * Never returns secrets or tokens.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  const env = getServerEnv();
  const hasCredentials = Boolean(env.CDSE_CLIENT_ID && env.CDSE_CLIENT_SECRET);

  if (!hasCredentials) {
    return NextResponse.json(
      {
        status: "unconfigured",
        dataSource,
        message: "CDSE credentials are not set. Add CDSE_CLIENT_ID and CDSE_CLIENT_SECRET to .env.local.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { expiresIn } = await getTokenHealth();
    return NextResponse.json(
      {
        status: "ok",
        dataSource,
        tokenValidForSeconds: expiresIn,
        wmtsEnabled: hasWmtsInstance(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
