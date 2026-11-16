import { NextResponse } from "next/server";
import { fromArrayBuffer } from "geotiff";
import { z } from "zod";
import { authorize, consumeRoleQuota } from "@/lib/auth/guard";
import { renderSceneImage } from "@/lib/cdse/process";
import { errorResponse, rateLimitGuard } from "@/lib/server/api";

export const runtime = "nodejs";
/** 30 s — one tiny Process API render for a 3×3 px box. */
export const maxDuration = 30;

const bodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  composite: z.enum(["true-color", "false-color", "ndvi"]),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/** SCL classes that count as cloudy/snowy for the clear flag. */
const CLOUDY_SCL = new Set([3, 8, 9, 10]);
/** Nodata stamp from the analysis evalscript. */
const NODATA = -9999;

/**
 * POST /api/imagery/sample { date, composite, lng, lat }
 *
 * On-demand "Sample NDVI here" for the map inspector (Phase 1): renders a
 * ~30 m box (3×3 px) around the clicked point as the 8-band analysis
 * GeoTIFF (…, NDVI, SCL) and returns just the facts — centre NDVI and a
 * clear/cloudy verdict from the SCL majority — never the raster itself.
 * Metered per role (inspect.sample capability: guest 10/day, SSO 100/day)
 * and against the shared render budget inside renderSceneImage.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request);
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const raw: unknown = await request.json().catch(() => null);
    const body = bodySchema.parse(raw);

    const quota = consumeRoleQuota(auth, "inspectSample");
    if (quota) return quota;

    // 30 m square centred on the point (analysis output is 3 px → 10 m/px).
    const dLat = 30 / 111_320;
    const cosLat = Math.max(Math.cos((body.lat * Math.PI) / 180), 1e-6);
    const dLng = 30 / (111_320 * cosLat);
    const [lng, lat] = [body.lng, body.lat];
    const geometry: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [lng - dLng / 2, lat - dLat / 2],
          [lng + dLng / 2, lat - dLat / 2],
          [lng + dLng / 2, lat + dLat / 2],
          [lng - dLng / 2, lat + dLat / 2],
          [lng - dLng / 2, lat - dLat / 2],
        ],
      ],
    };

    const buffer = await renderSceneImage({
      geometry,
      date: body.date,
      composite: body.composite,
      format: "analysis",
      maxSize: 3,
    });

    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const tiff = await fromArrayBuffer(ab);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const [ndviBand, sclBand] = (await image.readRasters({
      width,
      height,
      samples: [6, 7],
    })) as Float32Array[];

    const count = width * height;
    const centre = Math.floor(count / 2);
    const ndviValues: number[] = [];
    let cloudy = 0;
    let clearSamples = 0;
    for (let i = 0; i < count; i++) {
      const ndvi = ndviBand[i] ?? NODATA;
      if (ndvi <= NODATA + 1) continue; // nodata
      ndviValues.push(ndvi);
      const scl = Math.round(sclBand[i] ?? NODATA);
      if (CLOUDY_SCL.has(scl)) cloudy += 1;
      else clearSamples += 1;
    }

    if (ndviValues.length === 0) {
      return NextResponse.json({
        ndvi: null,
        clear: null,
        date: body.date,
        composite: body.composite,
      });
    }

    const centreNdvi = ndviBand[centre];
    const ndvi =
      centreNdvi !== undefined && centreNdvi > NODATA + 1
        ? centreNdvi
        : ndviValues.reduce((sum, value) => sum + value, 0) / ndviValues.length;
    const clear = cloudy + clearSamples > 0 ? cloudy * 2 < ndviValues.length : null;

    return NextResponse.json(
      {
        ndvi: Math.round(ndvi * 1000) / 1000,
        clear,
        date: body.date,
        composite: body.composite,
      },
      { status: 200, headers: { "Cache-Control": "public, max-age=86400" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
