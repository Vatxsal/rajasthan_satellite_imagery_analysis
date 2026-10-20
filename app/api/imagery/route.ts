import { NextResponse } from "next/server";
import { z } from "zod";
import { renderSceneImage } from "@/lib/cdse/process";
import { bboxFromGeometry, bboxAreaKm2, type ClipGeometry } from "@/lib/cdse/geometry";
import { districtsFc, ilrsFc, tehsilsFc } from "@/lib/data/boundaries";
import { imageryCache, imageryCacheKey } from "@/lib/cache";
import { getServerEnv } from "@/lib/env";
import { binaryStreamResponse, errorResponse, rateLimitGuard, readJsonBody, sameOriginGuard } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_SIZE = 1024;

const geometrySchema = z.union([
  z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(z.array(z.number()))).min(1) }),
  z.object({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(z.array(z.array(z.array(z.number())))).min(1),
  }),
]);

const areaIdsSchema = {
  districtId: z.string().trim().min(1).nullish(),
  tehsilId: z.string().trim().min(1).nullish(),
  ilrId: z.string().trim().min(1).nullish(),
};

const querySchema = z.object({
  ...areaIdsSchema,
  /** Optional raw GeoJSON (JSON-encoded) clip; takes precedence over area ids. */
  geometry: z.string().max(200_000).nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  composite: z.enum(["true-color", "false-color", "ndvi"]).default("true-color"),
  size: z.coerce.number().int().min(64).max(4096).default(DEFAULT_SIZE),
  format: z.enum(["png", "tiff", "analysis"]).default("png"),
});

const postSchema = z.object({
  ...areaIdsSchema,
  /** Preferred: explicit GeoJSON clip of the most specific selection. */
  geometry: geometrySchema.nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  composite: z.enum(["true-color", "false-color", "ndvi"]).default("true-color"),
  size: z.coerce.number().int().min(64).max(4096).default(DEFAULT_SIZE),
  format: z.enum(["png", "tiff", "analysis"]).default("png"),
});

/** Downloads larger than this are blocked with a friendly message. */
const MAX_DOWNLOAD_PX = 2500;

function geometryFromIds(params: {
  districtId?: string | null;
  tehsilId?: string | null;
  ilrId?: string | null;
}): ClipGeometry | null {
  if (params.ilrId) {
    const feature = ilrsFc.features.find((f) => f.properties?.id === params.ilrId);
    if (feature) return feature.geometry as ClipGeometry;
  }
  if (params.tehsilId) {
    const feature = tehsilsFc.features.find((f) => f.properties?.id === params.tehsilId);
    if (feature) return feature.geometry as ClipGeometry;
  }
  if (params.districtId) {
    const feature = districtsFc.features.find((f) => f.properties?.id === params.districtId);
    if (feature) return feature.geometry as ClipGeometry;
  }
  return null;
}

async function renderCached(
  geometry: ClipGeometry,
  date: string,
  composite: string,
  size: number,
  format: "png" | "tiff" | "analysis",
): Promise<Response> {
  const env = getServerEnv();
  const key = imageryCacheKey({ geometry, date, composite, size, format });
  const contentType = format === "png" ? "image/png" : "image/tiff";

  const cached = imageryCache.get(key);
  if (cached) {
    return binaryStreamResponse(cached, {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${Math.floor(env.IMAGERY_CACHE_TTL_SECONDS / 2)}, stale-while-revalidate=${env.IMAGERY_CACHE_TTL_SECONDS}`,
      "X-Imagery-Cache": "hit",
    });
  }

  const buffer = await renderSceneImage({
    geometry,
    date,
    composite: composite as "true-color" | "false-color" | "ndvi",
    maxSize: size,
    format,
  });
  imageryCache.set(key, buffer, env.IMAGERY_CACHE_TTL_SECONDS);

  return binaryStreamResponse(buffer, {
    "Content-Type": contentType,
    "Cache-Control": `public, max-age=${Math.floor(env.IMAGERY_CACHE_TTL_SECONDS / 2)}, stale-while-revalidate=${env.IMAGERY_CACHE_TTL_SECONDS}`,
    "X-Imagery-Cache": "miss",
  });
}

function tooLargeResponse(geometry: ClipGeometry): NextResponse | null {
  const env = getServerEnv();
  const bbox = bboxFromGeometry(geometry);
  if (bbox && bboxAreaKm2(bbox) > env.MAX_AOI_KM2) {
    return NextResponse.json(
      {
        code: "AOI_TOO_LARGE",
        message: `Area too large for live imagery. Pick a smaller district, tehsil, or ILR area (limit ${env.MAX_AOI_KM2.toLocaleString()} km²).`,
      },
      { status: 400 },
    );
  }
  return null;
}

function downloadTooLargeResponse(size: number): NextResponse | null {
  if (size <= MAX_DOWNLOAD_PX) return null;
  return NextResponse.json(
    {
      code: "DOWNLOAD_TOO_LARGE",
      message: `This download would be ${size}×${size} px (limit ${MAX_DOWNLOAD_PX}×${MAX_DOWNLOAD_PX} px). Select a tehsil or ILR area, or a smaller district.`,
    },
    { status: 400 },
  );
}

/** GET /api/imagery — geometry via ids or JSON-encoded `geometry` query param (thumbnails). */
export async function GET(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  try {
    const url = new URL(request.url);
    const params = querySchema.parse({
      districtId: url.searchParams.get("districtId"),
      tehsilId: url.searchParams.get("tehsilId"),
      ilrId: url.searchParams.get("ilrId"),
      geometry: url.searchParams.get("geometry"),
      date: url.searchParams.get("date"),
      composite: url.searchParams.get("composite") ?? undefined,
      size: url.searchParams.get("size") ?? undefined,
      format: url.searchParams.get("format") ?? undefined,
    });

    let geometry: ClipGeometry | null = null;
    if (params.geometry) {
      try {
        geometry = geometrySchema.parse(JSON.parse(params.geometry)) as ClipGeometry;
      } catch {
        return NextResponse.json(
          { code: "INVALID_GEOMETRY", message: "geometry must be a valid GeoJSON Polygon or MultiPolygon." },
          { status: 400 },
        );
      }
    } else {
      geometry = geometryFromIds(params);
    }
    if (!geometry) {
      return NextResponse.json(
        { code: "NO_GEOMETRY", message: "Provide districtId, tehsilId, ilrId, or a geometry." },
        { status: 400 },
      );
    }

    const tooLarge = tooLargeResponse(geometry);
    if (tooLarge) return tooLarge;
    const dlTooLarge = downloadTooLargeResponse(params.size);
    if (dlTooLarge) return dlTooLarge;

    return await renderCached(geometry, params.date, params.composite, params.size, params.format);
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/imagery — GeoJSON clip in the body (preferred) or area ids. */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  try {
    const body = await readJsonBody(request, (raw) => postSchema.parse(raw));

    const geometry: ClipGeometry | null = body.geometry
      ? (body.geometry as ClipGeometry)
      : geometryFromIds(body);
    if (!geometry) {
      return NextResponse.json(
        { code: "NO_GEOMETRY", message: "Provide districtId, tehsilId, ilrId, or a geometry." },
        { status: 400 },
      );
    }

    const tooLarge = tooLargeResponse(geometry);
    if (tooLarge) return tooLarge;
    const dlTooLarge = downloadTooLargeResponse(body.size);
    if (dlTooLarge) return dlTooLarge;

    return await renderCached(geometry, body.date, body.composite, body.size, body.format);
  } catch (error) {
    return errorResponse(error);
  }
}
