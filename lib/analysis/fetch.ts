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
import { assertProcessOutputSize, type ClipGeometry } from "@/lib/cdse/geometry";
import type { BBox } from "@/lib/data";
import { COMPARE_EVALSCRIPT, COMPARE_EVALSCRIPT_COMPOSITE } from "./evalscript";
import { compositeTimeRange } from "./composite";

export interface CompareRasterSize {
  width: number;
  height: number;
}

/** One entry of Process API `input.data` (dataset-specific filters). */
export interface ProcessDataInput {
  type: string;
  id?: string;
  dataFilter?: Record<string, unknown>;
  processing?: Record<string, unknown>;
}

interface ProcessOptions {
  geometry: ClipGeometry;
  evalscript: string;
  size: CompareRasterSize;
  /** Dataset entries — sentinel-2-l2a by default, sentinel-1-grd for SAR.
   *  Each entry carries its own dataFilter.timeRange. */
  data: ProcessDataInput[];
}

export async function fetchAnalysisRaster(options: ProcessOptions): Promise<Buffer> {
  const { geometry, evalscript, size, data } = options;
  // Last-line guard: never POST an output the Process API must refuse —
  // the caller gets a clear message and no processing units are spent.
  assertProcessOutputSize(size.width, size.height);
  const env = getServerEnv();
  const token = await getAccessToken();
  consumeRenderBudget(); // once per user-facing fetch, retries don't bill twice

  // Transient failures (timeout / 5xx / empty): one retry, as before.
  const MAX_ATTEMPTS = 2;
  // HTTP 429 per-minute rate limit: up to two retries honoring Retry-After.
  // Quota exhaustion (CDSE_QUOTA) and payload rejections (CDSE_BAD_REQUEST)
  // are deterministic — they surface immediately, never retried.
  const MAX_RATE_RETRIES = 2;
  let attempt = 0;
  let rateRetries = 0;
  // Render time grows with the raster area: a 1500 px composite measured
  // ~65-135 s, and a clamped-to-2500 px screening pass is ~2.8× that. Scale
  // the deadline from the output size so a legitimate big render is not
  // timed out locally (capped at 5 minutes, the route's own budget).
  const areaFactor = Math.max(1, (size.width * size.height) / (1500 * 1500));
  const baseTimeoutMs = Math.min(300_000, Math.round(90_000 * areaFactor));

  for (;;) {
    attempt += 1;
    try {
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
            data,
          },
          output: {
            width: size.width,
            height: size.height,
            responses: [{ identifier: "default", format: { type: "image/tiff" } }],
          },
          evalscript,
        }),
        cache: "no-store",
        // One generous retry covers queue spikes without letting a dead
        // render hang forever; the second attempt gets a quarter more.
        signal: AbortSignal.timeout(
          attempt === 1 ? baseTimeoutMs : Math.round(baseTimeoutMs * 1.25),
        ),
      });

      if (!response.ok) {
        // Rate limit: back off by Retry-After (clamped 1-30 s) and retry —
        // but only while it is the per-minute limit, not exhausted quota.
        if (response.status === 429) {
          const body = await response.text().catch(() => "");
          const mapped = mapCdseStatus(429, body);
          if (mapped.code === "CDSE_RATE_LIMIT" && rateRetries < MAX_RATE_RETRIES) {
            rateRetries += 1;
            const retryAfterSeconds = Number(response.headers.get("Retry-After"));
            const delay = Math.max(1, Math.min(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 5, 30)) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw mapped;
        }
        throw mapCdseStatus(response.status, await response.text().catch(() => ""));
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0) {
        throw mapCdseStatus(502, "Empty analysis raster from Copernicus.");
      }
      return buffer;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const codeText = typeof code === "string" ? code : "";
      // Retried here: timeouts/resets (no code) and upstream 5xx/empty.
      // Never retried: CDSE_AUTH, CDSE_QUOTA, CDSE_BAD_REQUEST,
      // CDSE_RATE_LIMIT (already past its retry budget) and the local
      // PROCESS_OUTPUT_TOO_LARGE guard.
      const retryable = codeText === "" || codeText === "CDSE_UPSTREAM";
      if (retryable && attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        continue;
      }
      throw error;
    }
  }
}

/** v1 input: one UTC day (mosaic of that day's scenes). */
export async function fetchCompareRaster(
  geometry: ClipGeometry,
  date: string,
  bbox: BBox,
  size: CompareRasterSize,
): Promise<Buffer> {
  const timeRange = { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` };
  return fetchAnalysisRaster({
    geometry,
    evalscript: COMPARE_EVALSCRIPT,
    size,
    data: [
      {
        type: "sentinel-2-l2a",
        dataFilter: { timeRange, mosaickingOrder: "mostRecent" },
        processing: { upsampling: "BICUBIC", downsampling: "BILINEAR" },
      },
    ],
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
  const timeRange = compositeTimeRange(date, windowDays, otherDate);
  return fetchAnalysisRaster({
    geometry,
    evalscript: COMPARE_EVALSCRIPT_COMPOSITE,
    size,
    data: [
      {
        type: "sentinel-2-l2a",
        dataFilter: { timeRange, mosaickingOrder: "mostRecent" },
        processing: { upsampling: "BICUBIC", downsampling: "BILINEAR" },
      },
    ],
  });
}
