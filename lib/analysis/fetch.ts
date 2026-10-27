/**
 * Fetches one date's analysis raster (5-band FLOAT32 GeoTIFF) from the
 * Sentinel Hub Process API — same call shape as lib/cdse/process.ts
 * (getAccessToken + consumeRenderBudget + 60 s timeout), but with our compare
 * evalscript and a fixed output grid shared by both dates.
 */
import { getServerEnv } from "@/lib/env";
import { consumeRenderBudget } from "@/lib/server/budget";
import { getAccessToken } from "@/lib/cdse/auth";
import { mapCdseStatus } from "@/lib/cdse/errors";
import type { BBox } from "@/lib/data";
import type { ClipGeometry } from "@/lib/cdse/geometry";
import { COMPARE_EVALSCRIPT } from "./evalscript";

export interface CompareRasterSize {
  width: number;
  height: number;
}

export async function fetchCompareRaster(
  geometry: ClipGeometry,
  date: string,
  bbox: BBox,
  size: CompareRasterSize,
): Promise<Buffer> {
  const env = getServerEnv();
  const token = await getAccessToken();
  consumeRenderBudget();

  const response = await fetch(`${env.CDSE_SH_BASE_URL}/api/v1/process`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "image/tiff",
    },
    body: JSON.stringify({
      input: {
        bounds: {
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" },
          geometry,
        },
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: {
                from: `${date}T00:00:00Z`,
                to: `${date}T23:59:59Z`,
              },
              mosaickingOrder: "mostRecent",
            },
            processing: { upsampling: "BILINEAR", downsampling: "BILINEAR" },
          },
        ],
      },
      output: {
        width: size.width,
        height: size.height,
        responses: [{ identifier: "default", format: { type: "image/tiff" } }],
      },
      evalscript: COMPARE_EVALSCRIPT,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw mapCdseStatus(response.status, await response.text().catch(() => ""));
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw mapCdseStatus(502, "Empty analysis raster from Copernicus.");
  }
  return buffer;
}
