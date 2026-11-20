import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, rateLimitGuard, readJsonBody, sameOriginGuard } from "@/lib/server/api";
import { requireCapability } from "@/lib/auth/guard";
import { polygonSchema } from "@/lib/draw/schema";
import { measureDrawGeometry, normalizeDrawGeometry, validateDrawGeometry } from "@/lib/draw/geometry";
import { serverDrawLimits } from "@/lib/server/drawLimits";
import { serverRajasthanOutline } from "@/lib/server/rajasthan";
import { shapefileZip } from "@/lib/server/shapefile";

export const runtime = "nodejs";

const exportBodySchema = z.object({
  name: z.string().trim().max(80).optional(),
  geometry: polygonSchema,
});

/**
 * POST /api/shapes/export — one drawn shape as a shapefile .zip
 * (.shp + .dbf + .prj, WGS84). Guards mirror the analyze route minus the
 * imagery/PU stages: origin → rate limit → session + draw.export.shapefile
 * (SSO-only) → schema → the same server-authoritative shape rules → archive.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  const capabilityGuard = await requireCapability(request, "draw.export.shapefile");
  if (capabilityGuard) return capabilityGuard;

  try {
    const body = await readJsonBody(request, (raw) => exportBodySchema.parse(raw));

    const validity = validateDrawGeometry(
      body.geometry,
      serverRajasthanOutline(),
      serverDrawLimits(),
    );
    if (!validity.ok) {
      return NextResponse.json(
        { code: "SHAPE_INVALID", message: validity.message, validity },
        { status: 400 },
      );
    }
    const geometry = normalizeDrawGeometry(body.geometry);
    if (geometry.type !== "Polygon") {
      return NextResponse.json(
        { code: "SHAPE_INVALID", message: "Shape could not be normalised." },
        { status: 400 },
      );
    }

    const metrics = measureDrawGeometry(geometry);
    const name = body.name?.trim() || "Shape";
    const { baseName, zip } = shapefileZip(geometry, {
      name,
      ha: metrics ? metrics.areaM2 / 10_000 : 0,
    });

    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${baseName}.zip"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
