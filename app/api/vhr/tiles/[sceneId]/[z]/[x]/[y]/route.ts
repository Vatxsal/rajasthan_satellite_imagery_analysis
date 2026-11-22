import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/guard";
import { getServerEnv } from "@/lib/env";
import { apiError, errorResponse, rateLimitGuard } from "@/lib/server/api";

export const runtime = "nodejs";

/**
 * GET /api/vhr/tiles/{sceneId}/{z}/{x}/{y} — private Supabase Storage proxy
 * for one Bhoonidhi XYZ tile. Session + `vhr.view` (SSO only) on every hit;
 * the bucket stays private and the service-role key never leaves the server.
 * Missing tiles answer the verified-transparent 1×1 PNG so MapLibre keeps
 * rendering; hits cache immutably (a scene's tile pyramid never changes).
 */

/**
 * 1×1 fully transparent PNG (rgba(0,0,0,0), color type 6) — copied from the
 * native tile route; the common "transparent pixel" base64 found online
 * decodes to a semi-transparent blue that washes every skipped tile.
 */
const EMPTY_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==",
  "base64",
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** gdal2tiles pyramids never exceed z22 for a ≤400 km² AOI. */
const MAX_ZOOM = 22;

function parseTileParam(raw: string): number | null {
  const value = Number.parseInt(raw.replace(/\.png$/i, ""), 10);
  return Number.isInteger(value) ? value : null;
}

function emptyTileResponse(): NextResponse {
  return new NextResponse(new Uint8Array(EMPTY_TILE), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // Misses are stable too, but keep the window short so a partially
      // ingested scene (or a fixed path) recovers without a purge.
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "X-Tile-Skip": "not-found",
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: { sceneId: string; z: string; x: string; y: string } },
): Promise<Response> {
  const guard = rateLimitGuard(request, "tiles");
  if (guard) return guard;

  const denied = await requireCapability(request, "vhr.view");
  if (denied) return denied;

  try {
    if (!UUID_RE.test(params.sceneId)) {
      return NextResponse.json(
        { code: "INVALID_SCENE", message: "Scene id must be a UUID." },
        { status: 400 },
      );
    }
    const z = parseTileParam(params.z);
    const x = parseTileParam(params.x);
    const y = parseTileParam(params.y);
    if (z === null || x === null || y === null || z < 0 || z > MAX_ZOOM) {
      return NextResponse.json(
        { code: "INVALID_TILE", message: `Tile coordinates must be integers (z 0-${MAX_ZOOM}).` },
        { status: 400 },
      );
    }
    const maxIndex = 2 ** z;
    if (x < 0 || y < 0 || x >= maxIndex || y >= maxIndex) {
      return NextResponse.json(
        { code: "INVALID_TILE", message: `x/y out of range for zoom ${z}.` },
        { status: 400 },
      );
    }

    const env = getServerEnv();
    const supabaseUrl = env.SUPABASE_URL?.trim();
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        {
          code: "SUPABASE_NOT_CONFIGURED",
          message: "High-resolution imagery storage is not configured.",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }

    const objectPath = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/vhr-tiles/${params.sceneId}/${z}/${x}/${y}.png`;
    let response: Response;
    try {
      response = await fetch(objectPath, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      });
    } catch {
      throw apiError(503, "STORAGE_UNAVAILABLE", "High-resolution imagery storage is unavailable right now.");
    }

    if (response.status === 404) return emptyTileResponse();
    if (!response.ok) {
      // 401/403 are configuration faults, 5xx an outage — none of the
      // upstream detail (URL, keys) may reach the client.
      throw apiError(503, "STORAGE_UNAVAILABLE", "High-resolution imagery storage is unavailable right now.");
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
