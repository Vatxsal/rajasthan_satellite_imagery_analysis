import type { BBox, Scene } from "@/lib/data";

/**
 * Scene downloads via POST /api/imagery (clipped to the selected polygon):
 *  - "png"      preview render, 8-bit RGBA — quick look, NOT for analysis;
 *  - "tiff"     GeoTIFF, visual: 8-bit RGB + alpha, georeferenced, 10 m;
 *  - "analysis" GeoTIFF, analysis: 8-band FLOAT32 (B02/B03/B04/B08/B11/B12 +
 *               NDVI + SCL), nodata -9999, georeferenced, band descriptions.
 *
 * Native output is 10 m/px. Areas whose native size exceeds MAX_DOWNLOAD_PX
 * are never fetched directly — planDownload() reports the reduced size and
 * the UI confirms it with the user before requesting it.
 */

export type DownloadFormat = "png" | "tiff" | "analysis";

/** Formats that produce a GeoTIFF rather than a PNG. */
export function isGeoTiff(format: DownloadFormat): boolean {
  return format !== "png";
}

/** Human label used in progress toasts and the download menu. */
export const DOWNLOAD_FORMAT_LABELS: Record<DownloadFormat, string> = {
  png: "PNG preview",
  tiff: "visual GeoTIFF",
  analysis: "analysis GeoTIFF",
};

/** Server-side + client-side guard: outputs longer than this are capped. */
export const MAX_DOWNLOAD_PX = 2500;

export interface DownloadTarget {
  name: string;
  geometry: GeoJSON.Polygon;
  bbox: BBox;
}

/** Native 10 m pixel size of a WGS84 bbox (aspect-corrected, no cap). */
export function nativeDownloadSize(bbox: BBox): { width: number; height: number } {
  const [west, south, east, north] = bbox;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const width = Math.max(1, Math.round((Math.abs(east - west) * 111_320 * Math.cos(midLatRad)) / 10));
  const height = Math.max(1, Math.round((Math.abs(north - south) * 110_574) / 10));
  return { width, height };
}

function fileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "area"
  );
}

export interface DownloadPlan {
  /** Output pixel size to request (long side always ≤ MAX_DOWNLOAD_PX). */
  size: { width: number; height: number };
  /** Native 10 m pixel dimensions of the area (may exceed the cap). */
  native: { width: number; height: number };
  /** True when native exceeds the cap → the UI must confirm reduced output. */
  reduced: boolean;
  /** Effective ground resolution of the planned output, metres per pixel. */
  metersPerPixel: number;
}

/**
 * Decides what a download of `target` would produce: full 10 m when it fits
 * the cap, otherwise a reduced-resolution version scaled to the cap.
 */
export function planDownload(target: DownloadTarget): DownloadPlan {
  const native = nativeDownloadSize(target.bbox);
  const longSide = Math.max(native.width, native.height);
  if (longSide <= MAX_DOWNLOAD_PX) {
    return { size: native, native, reduced: false, metersPerPixel: 10 };
  }
  const scale = MAX_DOWNLOAD_PX / longSide;
  const size = {
    width: Math.min(MAX_DOWNLOAD_PX, Math.max(1, Math.round(native.width * scale))),
    height: Math.min(MAX_DOWNLOAD_PX, Math.max(1, Math.round(native.height * scale))),
  };
  return {
    size,
    native,
    reduced: true,
    metersPerPixel: (longSide * 10) / MAX_DOWNLOAD_PX,
  };
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      // Malformed percent-encoding → fall through to the plain form.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain ? plain[1].trim() : null;
}

function defaultFilename(
  scene: Scene,
  target: DownloadTarget,
  format: DownloadFormat,
): string {
  // <area>_<date>_<composite|analysis>.<ext>
  const ext = format === "png" ? "png" : "tif";
  const variant = format === "analysis" ? "analysis" : scene.composite;
  return `${fileSlug(target.name)}_${scene.date}_${variant}.${ext}`;
}

export type DownloadResult =
  | { ok: true; filename: string }
  | { ok: false; message: string };

export async function downloadScene(
  scene: Scene,
  target: DownloadTarget,
  format: DownloadFormat,
  opts?: { size?: { width: number; height: number } },
): Promise<DownloadResult> {
  const native = nativeDownloadSize(target.bbox);
  const size = opts?.size
    ? Math.max(opts.size.width, opts.size.height)
    : Math.max(native.width, native.height);
  // Final guard — the UI normally confirms a reduced size via planDownload().
  if (size > MAX_DOWNLOAD_PX) {
    return {
      ok: false,
      message: `This download would be ~${native.width}×${native.height} px (limit ${MAX_DOWNLOAD_PX}×${MAX_DOWNLOAD_PX} px). Select a tehsil or ILR area, or a smaller district.`,
    };
  }

  let response: Response;
  try {
    response = await fetch("/api/imagery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        geometry: target.geometry,
        date: scene.date,
        composite: scene.composite,
        size,
        format,
      }),
    });
  } catch {
    return { ok: false, message: "Download failed — check your connection and try again." };
  }

  if (!response.ok) {
    let message = `Download failed (${response.status}).`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // non-JSON error body
    }
    return { ok: false, message };
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { ok: false, message: "Download failed — the file could not be read." };
  }

  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ??
    defaultFilename(scene, target, format);

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke late: revoking synchronously after click() can cancel the save.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return { ok: true, filename };
}
