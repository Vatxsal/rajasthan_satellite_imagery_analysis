import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCapability } from "@/lib/auth/guard";
import { getServerEnv } from "@/lib/env";
import { apiError, errorResponse, rateLimitGuard } from "@/lib/server/api";
import type { VhrBBox, VhrScene } from "@/lib/vhr/types";

export const runtime = "nodejs";

/** Newest-first fetch cap; bbox overlap is filtered in JS below. */
const SCENE_LIMIT = 100;

const SELECT_COLUMNS =
  "id,sensor,acquired_at,resolution_m,min_zoom,max_zoom,min_lng,min_lat,max_lng,max_lat,bands,license_note";

/**
 * `?bbox=minLng,minLat,maxLng,maxLat` → tuple, with range/order checks so a
 * malformed bbox never reaches the storage query.
 */
const bboxSchema = z
  .string()
  .min(1, "bbox is required.")
  .transform((raw, ctx) => {
    const parts = raw.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bbox must be minLng,minLat,maxLng,maxLat." });
      return z.NEVER;
    }
    const [west, south, east, north] = parts as VhrBBox;
    if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bbox is inverted or out of range." });
      return z.NEVER;
    }
    return [west, south, east, north] as VhrBBox;
  });

/** Raw vhr_scenes row as PostgREST returns it (snake_case columns). */
interface VhrRow {
  id: string;
  sensor: string;
  acquired_at: string;
  resolution_m: number;
  min_zoom: number;
  max_zoom: number;
  min_lng: number;
  min_lat: number;
  max_lng: number;
  max_lat: number;
  bands: unknown;
  license_note: string | null;
}

function overlaps(a: VhrBBox, b: VhrBBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function toScene(row: VhrRow): VhrScene {
  return {
    id: row.id,
    sensor: row.sensor,
    acquiredAt: row.acquired_at,
    resolutionM: Number(row.resolution_m),
    minZoom: Number(row.min_zoom),
    maxZoom: Number(row.max_zoom),
    bbox: [Number(row.min_lng), Number(row.min_lat), Number(row.max_lng), Number(row.max_lat)],
    bands: Array.isArray(row.bands) ? row.bands.map(String) : [],
    licenseNote: row.license_note ?? "",
  };
}

/**
 * GET /api/vhr/scenes?bbox=w,s,e,n — high-resolution (Bhoonidhi) scenes
 * overlapping the requested bbox. SSO-only (vhr.view); the storage query runs
 * server-side with the service-role key, which never leaves this process.
 * Missing Supabase configuration answers 503 SUPABASE_NOT_CONFIGURED.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request, "api");
  if (guard) return guard;

  const denied = await requireCapability(request, "vhr.view");
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const bbox = bboxSchema.parse(url.searchParams.get("bbox"));

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

    const query = new URLSearchParams({
      select: SELECT_COLUMNS,
      order: "acquired_at.desc",
      limit: String(SCENE_LIMIT),
    });
    const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/vhr_scenes?${query}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
      // Route handlers are dynamic; keep the CDN from caching a role-gated list.
      cache: "no-store",
    });
    if (!response.ok) {
      throw apiError(503, "STORAGE_UNAVAILABLE", "High-resolution imagery storage is unavailable right now.");
    }
    const rows = (await response.json()) as VhrRow[];
    if (!Array.isArray(rows)) {
      throw apiError(503, "STORAGE_UNAVAILABLE", "High-resolution imagery storage is unavailable right now.");
    }

    const scenes = rows
      .filter((row) => {
        const sceneBox: VhrBBox = [Number(row.min_lng), Number(row.min_lat), Number(row.max_lng), Number(row.max_lat)];
        return sceneBox.every(Number.isFinite) && overlaps(sceneBox, bbox);
      })
      .map(toScene);

    return NextResponse.json({ scenes }, { headers: { "cache-control": "private, max-age=60" } });
  } catch (error) {
    return errorResponse(error);
  }
}
