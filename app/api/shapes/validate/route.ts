import { NextResponse } from "next/server";
import { z } from "zod";
import {
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import { requireCapability } from "@/lib/auth/guard";
import { drawGeometrySchema } from "@/lib/draw/schema";
import {
  measureDrawGeometry,
  normalizeDrawGeometry,
  validateDrawGeometry,
} from "@/lib/draw/geometry";
import { serverDrawLimits } from "@/lib/server/drawLimits";
import { serverRajasthanOutline } from "@/lib/server/rajasthan";

export const runtime = "nodejs";

const validateBodySchema = z.object({ geometry: drawGeometrySchema });

/**
 * POST /api/shapes/validate — the authoritative copy of the HUD rules.
 *
 * Body: { geometry: Polygon | LineString } (the draft or committed shape).
 * 200 always, with the result in the body:
 *   { validity: DrawValidity, metrics: DrawMetrics, normalized: geometry }
 * `validity.ok=false, kind:"pending"` means "not finished yet" (client keeps
 * Finish disabled); `kind:"error"` is a real rule violation. `normalized` is
 * the canonical form (duplicate points dropped, rings closed) — save/analyze
 * endpoints store that, never the raw client bytes.
 *
 * Guards: same-origin + per-IP rate limit + session with the draw.basic
 * capability. Malformed bodies are 400 INVALID_REQUEST via the shared
 * contract. Numeric ceilings come from the DRAW_MAX_* env (server-authoritative).
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  const capabilityGuard = await requireCapability(request, "draw.basic");
  if (capabilityGuard) return capabilityGuard;

  try {
    const body = await readJsonBody(request, (raw) => validateBodySchema.parse(raw));
    const geometry = body.geometry as GeoJSON.Polygon | GeoJSON.LineString;
    const validity = validateDrawGeometry(
      geometry,
      serverRajasthanOutline(),
      serverDrawLimits(),
    );
    return NextResponse.json({
      validity,
      metrics: measureDrawGeometry(geometry),
      normalized: normalizeDrawGeometry(geometry),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
