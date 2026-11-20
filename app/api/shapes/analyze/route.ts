import { NextResponse } from "next/server";
import { fromArrayBuffer } from "geotiff";
import { z } from "zod";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import { authorize, forbiddenRoleResponse } from "@/lib/auth/guard";
import { can, exceedsSearchWindow } from "@/lib/auth/permissions";
import { dataSource, getServerEnv } from "@/lib/env";
import { searchCatalog, type CatalogHit } from "@/lib/cdse/catalog";
import { renderSceneImage } from "@/lib/cdse/process";
import { computeOutputSize } from "@/lib/cdse/geometry";
import { estimateRenderPu } from "@/lib/analysis/pu";
import { areaRefSchema, isoDate } from "@/lib/draw/schema";
import { ANALYSIS_INPUT_BANDS, ANALYZE_MAX_PX } from "@/lib/draw/constants";
import { measureDrawGeometry, validateDrawGeometry } from "@/lib/draw/geometry";
import { computeShapeStats, type ShapeStats } from "@/lib/draw/stats";
import { resolveAreaRef } from "@/lib/server/areaRef";
import { serverDrawLimits } from "@/lib/server/drawLimits";
import { serverRajasthanOutline } from "@/lib/server/rajasthan";

export const runtime = "nodejs";
export const maxDuration = 60;

const analyzeBodySchema = z.object({
  area: areaRefSchema,
  fromDate: isoDate,
  toDate: isoDate,
});

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
} as const;

const MOCK_ANALYZE_MESSAGE =
  "Shape analysis needs live Sentinel-2 data — set NEXT_PUBLIC_DATA_SOURCE=cdse with CDSE credentials.";

type SendFrame = (frame: unknown) => void;

/** Wraps an async frame writer in the shared NDJSON stream + error contract. */
function ndjsonResponse(write: (send: SendFrame) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SendFrame = (frame) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      try {
        await write(send);
        controller.close();
      } catch (error) {
        console.error(
          "[shapes:analyze] failed:",
          error instanceof Error ? `${error.name}: ${error.message}` : error,
        );
        try {
          send({ type: "error", ...streamErrorBody(error) });
          controller.close();
        } catch {
          // client disconnected — nothing left to do
        }
      }
    },
  });
  return new Response(stream, { status: 200, headers: NDJSON_HEADERS });
}

/** Maps mid-stream failures to the { code, message } contract (no HTTP status once streaming). */
function streamErrorBody(error: unknown): { code: string; message: string } {
  const err = error as { code?: unknown; message?: unknown };
  if (err && typeof err.code === "string") {
    return {
      code: err.code,
      message: typeof err.message === "string" ? err.message : "Shape analysis failed.",
    };
  }
  if (error instanceof Error && error.message.startsWith("Invalid environment configuration")) {
    return { code: "CDSE_CONFIG", message: error.message };
  }
  return { code: "UPSTREAM_ERROR", message: "Imagery service request failed. Try again shortly." };
}

/** Least-cloudy scene in the window (ties → newest date). */
function pickScene(hits: CatalogHit[]): CatalogHit | null {
  let best: CatalogHit | null = null;
  for (const hit of hits) {
    if (
      !best ||
      hit.cloudCover < best.cloudCover ||
      (hit.cloudCover === best.cloudCover && hit.date > best.date)
    ) {
      best = hit;
    }
  }
  return best;
}

/** NDVI (band 7) + SCL (band 8) of the analysis GeoTIFF, flattened. */
async function readShapeBands(buffer: Buffer): Promise<{ ndvi: Float32Array; scl: Float32Array }> {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const tiff = await fromArrayBuffer(ab as ArrayBuffer);
  const image = await tiff.getImage();
  const bands = (await image.readRasters({
    width: image.getWidth(),
    height: image.getHeight(),
    samples: [6, 7],
  })) as Float32Array[];
  return { ndvi: bands[0]!, scl: bands[1]! };
}

/**
 * POST /api/shapes/analyze — NDJSON statistics for one area (drawn shape or
 * admin unit) over the least-cloudy Sentinel-2 scene in a date window.
 *
 * Body: { area: AreaRef, fromDate, toDate }.
 * Streams newline-delimited JSON:
 *   {"type":"stage","stage":"render"|"stats"}          (progress, in order)
 *   {"type":"result","areaId","date","cloudCover",
 *    "satellite","pu","metrics","stats"}              (final)
 *   {"type":"error","code","message"}                 (mid-stream failure)
 * Pre-stream failures answer as normal { status, code, message } JSON —
 * including SHAPE_INVALID, which carries the shared `validity` object so the
 * client can render the exact rule that failed.
 *
 * Guard order: origin → rate limit → session → schema → search window →
 * area (validate + resolve) → PU pre-flight → mock source → catalogue.
 * One Process render (analysis GeoTIFF at ANALYZE_MAX_PX) — its estimated PU
 * rides in the result frame.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "compare");
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  if (!can(auth.role, "draw.analyze")) return forbiddenRoleResponse("draw.analyze");

  try {
    const env = getServerEnv();
    const body = await readJsonBody(request, (raw) => analyzeBodySchema.parse(raw));
    const [fromDate, toDate] =
      body.fromDate <= body.toDate ? [body.fromDate, body.toDate] : [body.toDate, body.fromDate];

    if (exceedsSearchWindow(auth.role, fromDate, toDate)) {
      const window = auth.limits.searchWindowDays;
      return NextResponse.json(
        {
          code: "SEARCH_WINDOW_EXCEEDED",
          message: `Scene search is limited to a ${window}-day window here. Sign in with an SSO ID for the full archive.`,
        },
        { status: 400 },
      );
    }

    // Shapes must pass the same spec-order rules the HUD shows (authoritative
    // copy — the failure carries `validity` for a faithful message).
    if (body.area.kind === "shape") {
      const validity = validateDrawGeometry(
        body.area.geometry,
        serverRajasthanOutline(),
        serverDrawLimits(),
      );
      if (!validity.ok) {
        return NextResponse.json(
          { code: "SHAPE_INVALID", message: validity.message, validity },
          { status: 400 },
        );
      }
    }
    const area = resolveAreaRef(body.area);
    if (!area) {
      if (body.area.kind === "shape") {
        return NextResponse.json(
          { code: "SHAPE_INVALID", message: "Shape could not be resolved." },
          { status: 400 },
        );
      }
      throw apiError(404, "AREA_NOT_FOUND", "Unknown area for this analysis.");
    }

    // Pure pre-flight — never billed, never fetched: one analysis render.
    const { width, height } = computeOutputSize(area.bbox, ANALYZE_MAX_PX);
    const estimatedPu = estimateRenderPu({
      width,
      height,
      inputBands: ANALYSIS_INPUT_BANDS,
      float: true,
      samples: 1,
    });
    if (env.PER_ANALYSIS_PU_LIMIT > 0 && estimatedPu > env.PER_ANALYSIS_PU_LIMIT) {
      throw apiError(
        413,
        "PU_LIMIT_EXCEEDED",
        `This analysis needs about ${estimatedPu.toFixed(2)} PU; the per-analysis ` +
          `limit is ${env.PER_ANALYSIS_PU_LIMIT} PU.`,
      );
    }

    // Last gate before any CDSE work: the mock catalogue has no imagery.
    if (dataSource === "mock") {
      throw apiError(400, "CDSE_CONFIG", MOCK_ANALYZE_MESSAGE);
    }

    const hits = await searchCatalog({
      bbox: area.bbox,
      from: fromDate,
      to: toDate,
      maxCloud: 100,
      limit: 50,
    });
    const scene = pickScene(hits);
    if (!scene) {
      throw apiError(
        400,
        "NO_SCENES",
        "No Sentinel-2 scenes found for this area in the selected dates.",
      );
    }

    // Admin boundary features are single polygons (resolveArea's cast); the
    // conservative MultiPolygon union member only exists for future datasets.
    const metrics =
      area.geometry.type === "Polygon" ? measureDrawGeometry(area.geometry) : null;
    const areaId = area.id;
    return ndjsonResponse(async (send) => {
      send({ type: "stage", stage: "render" });
      const buffer = await renderSceneImage({
        geometry: area.geometry,
        date: scene.date,
        composite: "ndvi",
        format: "analysis",
        maxSize: ANALYZE_MAX_PX,
      });
      send({ type: "stage", stage: "stats" });
      const { ndvi, scl } = await readShapeBands(buffer);
      const stats: ShapeStats = computeShapeStats(ndvi, scl);
      send({
        type: "result",
        areaId,
        date: scene.date,
        cloudCover: scene.cloudCover,
        satellite: scene.satellite,
        pu: estimatedPu,
        metrics,
        stats,
      });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
