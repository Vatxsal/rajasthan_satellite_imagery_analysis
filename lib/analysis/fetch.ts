/**
 * Fetches one date's analysis raster (FLOAT32 GeoTIFF) from the Sentinel Hub
 * Process API — same call shape as lib/cdse/process.ts (getAccessToken +
 * consumeRenderBudget + 60 s timeout), but with our compare evalscript and a
 * fixed output grid shared by both dates.
 *
 * Two input modes: v1 = single UTC day (one ORBIT sample), v2 = composite of
 * every valid orbit in a ±window (median per pixel, cloud-gated per sample).
 */
import { getServerEnv } from "@/lib/env";
import { consumeRenderBudget } from "@/lib/server/budget";
import { getAccessToken } from "@/lib/cdse/auth";
import { mapCdseStatus } from "@/lib/cdse/errors";
import type { BBox } from "@/lib/data";
import type { ClipGeometry } from "@/lib/cdse/geometry";
import { COMPARE_EVALSCRIPT, COMPARE_EVALSCRIPT_COMPOSITE } from "./evalscript";
import { compositeTimeRange } from "./composite";

export interface CompareRasterSize {
  width: number;
  height: number;
}

interface ProcessOptions {
  geometry: ClipGeometry;
  evalscript: string;
  timeRange: { from: string; to: string };
  size: CompareRasterSize;
}

async function fetchAnalysisRaster(options: ProcessOptions): Promise<Buffer> {
  const { geometry, evalscript, timeRange, size } = options;
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
              timeRange,
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
      evalscript,
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

/** v1 input: one UTC day (mosaic of that day's scenes). */
export async function fetchCompareRaster(
  geometry: ClipGeometry,
  date: string,
  bbox: BBox,
  size: CompareRasterSize,
): Promise<Buffer> {
  return fetchAnalysisRaster({
    geometry,
    evalscript: COMPARE_EVALSCRIPT,
    timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` },
    size,
  });
}

/** v2 input: median composite of every valid orbit in ±windowDays around `date`
 *  (window capped at the midpoint between the two compared dates). */
export async function fetchCompareCompositeRaster(
  geometry: ClipGeometry,
  date: string,
  bbox: BBox,
  size: CompareRasterSize,
  windowDays: number,
  otherDate: string,
): Promise<Buffer> {
  return fetchAnalysisRaster({
    geometry,
    evalscript: COMPARE_EVALSCRIPT_COMPOSITE,
    timeRange: compositeTimeRange(date, windowDays, otherDate),
    size,
  });
}
