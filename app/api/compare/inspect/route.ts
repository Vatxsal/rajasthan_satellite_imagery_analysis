import { NextResponse } from "next/server";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { authorize, forbiddenRoleResponse } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { inspectChangeAt } from "@/lib/inspect/changeGrid";
import { errorResponse, rateLimitGuard } from "@/lib/server/api";
import { entryForKey } from "@/lib/server/compareRun";

export const runtime = "nodejs";
/** 60 s — a cold cache now recomputes the analysis (same cost as analyze). */
export const maxDuration = 60;

const bodySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/, "key must be a 64-char hex digest"),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  // Optional analysis parameters → stateless recompute on a cache miss
  // (same contract as /api/compare/events and /api/compare/overlay).
  areaId: z.string().optional(),
  level: z.enum(["district", "tehsil", "ilr"]).optional(),
  dateA: z.string().optional(),
  dateB: z.string().optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
  minPatchHa: z.coerce.number().optional(),
  inputMode: z.enum(["single", "composite"]).optional(),
  compositeWindowDays: z.coerce.number().int().optional(),
});

/**
 * POST /api/compare/inspect { key, lng, lat, …analysis params }
 *
 * What the map inspector shows under a clicked point (Phase 1): the change
 * class of that pixel plus the patch polygon it belongs to (id, area,
 * confidence, evidence). Reads the cached classified raster (statelessly
 * recomputing on a cold cache when params are present); returns only
 * class/patch facts — no raster, no per-pixel bulk data. Pixel → class →
 * patch logic lives in lib/inspect/changeGrid (unit-tested).
 */
export async function POST(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  if (!can(auth.role, "inspect.basic")) return forbiddenRoleResponse("inspect.basic");

  try {
    const raw: unknown = await request.json().catch(() => null);
    const body = bodySchema.parse(raw);

    const entry = await entryForKey(body.key, body, { role: auth.role });
    const grid = inflateSync(entry.classGz);
    const result = inspectChangeAt(
      { grid, width: entry.width, height: entry.height, bbox: entry.bbox },
      entry.events.features,
      body.lng,
      body.lat,
    );

    const today = new Date().toISOString().slice(0, 10);
    const { dateA, dateB } = entry.stats.metadata;
    const lastDate = dateA > dateB ? dateA : dateB;
    const cacheControl =
      lastDate < today ? "public, max-age=31536000, immutable" : "public, max-age=3600";

    return NextResponse.json(
      {
        kind: result.kind,
        classCode: result.classCode,
        classLabel: result.classLabel,
        patch: result.patch,
      },
      { status: 200, headers: { "Cache-Control": cacheControl } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
