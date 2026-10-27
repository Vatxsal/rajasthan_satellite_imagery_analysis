import { z } from "zod";
import { searchCatalog, type CatalogHit } from "@/lib/cdse/catalog";
import { bboxAreaKm2, type ClipGeometry } from "@/lib/cdse/geometry";
import { runCompare } from "@/lib/analysis/analyze";
import type { DateSceneMeta } from "@/lib/analysis/types";
import { compareCacheKey, compareResultCache, type CompareArtifactEntry } from "@/lib/cache";
import { dataSource, getServerEnv } from "@/lib/env";
import { tehsilsFc } from "@/lib/data/boundaries";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import { resolveArea, type ResolvedArea } from "@/lib/server/areas";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Catalogue fetch cap per date — only existence + best-tile metadata needed. */
const CATALOG_LIMIT = 50;

const analyzeBodySchema = z
  .object({
    areaId: z.string().trim().min(1),
    level: z.enum(["district", "tehsil", "ilr"]),
    dateA: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateA must be YYYY-MM-DD"),
    dateB: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateB must be YYYY-MM-DD"),
    sensitivity: z.enum(["low", "medium", "high"]).default("medium"),
    minPatchHa: z.coerce.number().min(0.01).max(100).default(0.2),
  })
  .refine((value) => value.dateA !== value.dateB, {
    message: "Pick two different dates to compare.",
    path: ["dateB"],
  });

function sceneMeta(hits: CatalogHit[]): DateSceneMeta {
  const best = hits.reduce((a, b) => (a.cloudCover <= b.cloudCover ? a : b));
  return {
    date: best.date,
    cloudCover: best.cloudCover,
    satellite: best.satellite,
    tileCount: hits.length,
  };
}

/** Tehsil polygons of the selected district (zonal breakdown input); null elsewhere. */
function districtZones(area: ResolvedArea): Array<{
  id: string;
  name: string;
  geometry: ClipGeometry;
}> | null {
  if (area.level !== "district") return null;
  const zones: Array<{ id: string; name: string; geometry: ClipGeometry }> = [];
  for (const feature of tehsilsFc.features) {
    const props = feature.properties;
    if (!props) continue;
    if (String(props.districtId ?? "") !== area.id) continue;
    if (!feature.geometry) continue;
    zones.push({
      id: String(props.id ?? ""),
      name: String(props.name ?? props.id ?? "Tehsil"),
      geometry: feature.geometry as ClipGeometry,
    });
  }
  return zones.length > 0 ? zones : null;
}

/** Maps mid-stream failures to the { code, message } contract (no HTTP status once streaming). */
function streamErrorBody(error: unknown): { code: string; message: string } {
  const err = error as { code?: unknown; message?: unknown };
  if (err && typeof err.code === "string") {
    return { code: err.code, message: typeof err.message === "string" ? err.message : "Analysis failed." };
  }
  if (error instanceof Error && error.message.startsWith("Invalid environment configuration")) {
    return { code: "CDSE_CONFIG", message: error.message };
  }
  return { code: "UPSTREAM_ERROR", message: "Imagery service request failed. Try again shortly." };
}

/**
 * POST /api/compare/analyze
 *
 * Body: { areaId, level, dateA, dateB, sensitivity?, minPatchHa? }.
 * Streams newline-delimited JSON:
 *   {"type":"stage","stage":"fetch-a"|"fetch-b"|"analyze"}   (progress, in order)
 *   {"type":"result","key","overlayUrl","aiEnabled","stats"} (final)
 *   {"type":"error","code","message"}                        (mid-stream failure)
 * Validation/auth failures return normal { status, code, message } errors
 * before the stream starts.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "compare");
  if (guard) return guard;

  try {
    const env = getServerEnv();
    if (dataSource === "mock") {
      throw apiError(
        400,
        "CDSE_CONFIG",
        "Change detection needs live Sentinel-2 data — set NEXT_PUBLIC_DATA_SOURCE=cdse with CDSE credentials.",
      );
    }

    const body = await readJsonBody(request, (raw) => analyzeBodySchema.parse(raw));
    // Normalise order: A is always the earlier date.
    const [dateA, dateB] = body.dateA < body.dateB ? [body.dateA, body.dateB] : [body.dateB, body.dateA];

    const area = resolveArea(body.level, body.areaId);
    if (!area) {
      throw apiError(404, "AREA_NOT_FOUND", "Unknown area for this comparison.");
    }

    const areaKm2 = bboxAreaKm2(area.bbox);
    if (areaKm2 > env.MAX_AOI_KM2) {
      throw apiError(
        400,
        "AOI_TOO_LARGE",
        `Area too large for live imagery (~${Math.round(areaKm2).toLocaleString()} km²). Pick a smaller district, tehsil, or ILR area (limit ${env.MAX_AOI_KM2.toLocaleString()} km²).`,
      );
    }

    // Validate both dates exist over the area (also pre-warms the CDSE token,
    // so auth/config failures surface as HTTP errors, not stream frames).
    const hitsA = await searchCatalog({
      bbox: area.bbox,
      from: dateA,
      to: dateA,
      maxCloud: 100,
      limit: CATALOG_LIMIT,
    });
    if (hitsA.length === 0) {
      throw apiError(404, "COMPARE_NO_SCENE", `No Sentinel-2 scene on ${dateA} over ${area.name}.`);
    }
    const hitsB = await searchCatalog({
      bbox: area.bbox,
      from: dateB,
      to: dateB,
      maxCloud: 100,
      limit: CATALOG_LIMIT,
    });
    if (hitsB.length === 0) {
      throw apiError(404, "COMPARE_NO_SCENE", `No Sentinel-2 scene on ${dateB} over ${area.name}.`);
    }

    const key = compareCacheKey({
      areaId: area.id,
      level: area.level,
      dateA,
      dateB,
      sensitivity: body.sensitivity,
      minPatchHa: body.minPatchHa,
    });
    const aiEnabled = Boolean(env.GEMINI_API_KEY);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (frame: unknown): void => {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        };
        try {
          const cached = compareResultCache.get(key);
          if (cached) {
            send({ type: "stage", stage: "fetch-a" });
            send({ type: "stage", stage: "fetch-b" });
            send({ type: "stage", stage: "analyze" });
            send({ type: "result", key, overlayUrl: `/api/compare/overlay?key=${key}`, aiEnabled, stats: cached.stats });
            controller.close();
            return;
          }

          const artifact = await runCompare(
            {
              geometry: area.geometry,
              dateA,
              dateB,
              areaName: area.name,
              areaLevel: area.level,
              sensitivity: body.sensitivity,
              minPatchHa: body.minPatchHa,
              maxPx: env.COMPARE_MAX_PX,
              sceneA: sceneMeta(hitsA),
              sceneB: sceneMeta(hitsB),
              zones: districtZones(area),
            },
            (stage) => send({ type: "stage", stage }),
          );

          const entry: CompareArtifactEntry = {
            stats: artifact.result,
            overlayPng: artifact.overlayPng,
            classGz: artifact.classGz,
            width: artifact.width,
            height: artifact.height,
            bbox: artifact.bbox,
            geometry: area.geometry,
          };
          compareResultCache.set(key, entry, env.IMAGERY_CACHE_TTL_SECONDS);

          send({
            type: "result",
            key,
            overlayUrl: `/api/compare/overlay?key=${key}`,
            aiEnabled,
            stats: artifact.result,
          });
          controller.close();
        } catch (error) {
          try {
            send({ type: "error", ...streamErrorBody(error) });
            controller.close();
          } catch {
            // client disconnected — nothing left to do
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
