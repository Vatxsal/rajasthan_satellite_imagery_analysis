import type { CompositeId } from "@/lib/data";
import { getServerEnv } from "@/lib/env";
import { consumeRenderBudget } from "@/lib/server/budget";
import { getAccessToken } from "./auth";
import { mapCdseStatus } from "./errors";
import {
  ANALYSIS_BAND_DESCRIPTIONS,
  ANALYSIS_NODATA,
  evalscriptFor,
  evalscriptForDownload,
} from "./evalscripts";
import { withGeoTiffMetadata } from "./geotiff";
import { bboxFromGeometry, computeOutputSize, type ClipGeometry } from "./geometry";

export interface ProcessQuery {
  geometry: ClipGeometry;
  /** Acquisition date YYYY-MM-DD — the closest matching scene is expected. */
  date: string;
  composite: CompositeId;
  /** Long-side cap; defaults to 1024px. */
  maxSize?: number;
  /**
   * Output format.
   *  - "png"     (default) display render, 8-bit RGBA;
   *  - "tiff"    visual GeoTIFF, 8-bit RGB + alpha, georeferenced;
   *  - "analysis" analysis GeoTIFF, 8-band FLOAT32 with nodata + descriptions.
   */
  format?: "png" | "tiff" | "analysis";
}

/**
 * Renders a clipped RGBA PNG (or GeoTIFF) for one scene date via the Sentinel
 * Hub Process API. The GeoJSON geometry is used as the request bounds, so
 * pixels outside the district/tehsil/ILR polygon are transparent (PNG alpha)
 * or nodata (GeoTIFF).
 */
export async function renderSceneImage(query: ProcessQuery): Promise<Buffer> {
  const env = getServerEnv();
  const token = await getAccessToken();
  const bbox = bboxFromGeometry(query.geometry);
  if (!bbox) {
    throw Object.assign(new Error("Geometry has no coordinates."), {
      status: 400,
      code: "INVALID_GEOMETRY",
    });
  }

  const format = query.format ?? "png";
  const isTiff = format !== "png";
  const { width, height } = computeOutputSize(bbox, query.maxSize ?? 1024);
  consumeRenderBudget();

  const response = await fetch(`${env.CDSE_SH_BASE_URL}/api/v1/process`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: isTiff ? "image/tiff" : "image/png",
    },
    body: JSON.stringify({
      input: {
        bounds: {
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" },
          geometry: query.geometry,
        },
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: {
                from: `${query.date}T00:00:00Z`,
                to: `${query.date}T23:59:59Z`,
              },
            },
          },
        ],
      },
      output: {
        width,
        height,
        responses: [
          {
            identifier: "default",
            format: { type: isTiff ? "image/tiff" : "image/png" },
          },
        ],
      },
      evalscript: evalscriptForDownload(query.composite, format),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw mapCdseStatus(response.status, await response.text().catch(() => ""));
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw mapCdseStatus(502, "Empty image response from Copernicus.");
  }

  // Sentinel Hub cannot declare band names/nodata/alpha — stamp them on ourselves.
  if (format === "analysis") {
    return withGeoTiffMetadata(buffer, {
      bandDescriptions: ANALYSIS_BAND_DESCRIPTIONS,
      nodata: ANALYSIS_NODATA,
    });
  }
  if (format === "tiff") {
    return withGeoTiffMetadata(buffer, { nodata: "0", rgba: true });
  }
  return buffer;
}

export interface TileRenderQuery {
  /** Tile bbox in EPSG:3857 meters — the image is registered to this box. */
  bbox3857: [number, number, number, number];
  /** Area polygon converted to EPSG:3857 (must share the bbox CRS). */
  geometryMercator: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  date: string;
  composite: CompositeId;
  size: number;
}

/**
 * Renders one native-resolution XYZ tile (Copernicus Browser behaviour):
 * bounds.bbox = tile bbox (EPSG:3857), bounds.geometry = area polygon (same
 * CRS) so pixels outside the area are transparent, timeRange = the full UTC
 * day, mosaickingOrder "mostRecent", resampling BILINEAR.
 */
export async function renderTileImage(query: TileRenderQuery): Promise<Buffer> {
  const env = getServerEnv();
  const token = await getAccessToken();
  consumeRenderBudget();

  const response = await fetch(`${env.CDSE_SH_BASE_URL}/api/v1/process`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "image/png",
    },
    body: JSON.stringify({
      input: {
        bounds: {
          bbox: query.bbox3857,
          geometry: query.geometryMercator,
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/3857" },
        },
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: {
                from: `${query.date}T00:00:00Z`,
                to: `${query.date}T23:59:59Z`,
              },
              mosaickingOrder: "mostRecent",
            },
            processing: { upsampling: "BILINEAR", downsampling: "BILINEAR" },
          },
        ],
      },
      output: {
        width: query.size,
        height: query.size,
        responses: [{ identifier: "default", format: { type: "image/png" } }],
      },
      evalscript: evalscriptFor(query.composite),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw mapCdseStatus(response.status, await response.text().catch(() => ""));
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw mapCdseStatus(502, "Empty tile response from Copernicus.");
  }
  return buffer;
}
