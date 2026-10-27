/**
 * Preview imagery for the AI summary: renders date A / date B true-colour
 * PNGs (≤768 px, through the shared imagery cache so repeats are free) and
 * composites the classified overlay over date B. All three are encoded as
 * JPEG quality 80 and base64 — the only pixels that ever leave for the model.
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { ClipGeometry } from "@/lib/cdse/geometry";
import { renderSceneImage } from "@/lib/cdse/process";
import { getServerEnv } from "@/lib/env";
import { imageryCache, imageryCacheKey } from "@/lib/cache";

/** Long-side cap for every preview sent to Gemini. */
export const SUMMARY_IMAGE_MAX_PX = 768;
const JPEG_QUALITY = 80;
const FLATTEN: [number, number, number] = [255, 255, 255]; // white outside the polygon

export interface SummaryImage {
  mimeType: "image/jpeg";
  /** Base64. */
  data: string;
}

interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes/pixel. */
  data: Uint8Array;
}

/** Renders (or serves from the imagery cache) one true-colour PNG preview. */
async function renderPreview(geometry: ClipGeometry, date: string): Promise<RgbaImage> {
  const env = getServerEnv();
  const key = imageryCacheKey({
    geometry,
    date,
    composite: "true-color",
    size: SUMMARY_IMAGE_MAX_PX,
    format: "png",
  });
  let png = imageryCache.get(key);
  if (!png) {
    png = await renderSceneImage({
      geometry,
      date,
      composite: "true-color",
      maxSize: SUMMARY_IMAGE_MAX_PX,
      format: "png",
    });
    imageryCache.set(key, png, env.IMAGERY_CACHE_TTL_SECONDS);
  }
  const decoded = PNG.sync.read(png);
  return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) };
}

/** Nearest-neighbour resize (overlay mask → exact preview dimensions). */
function scaleNearest(src: RgbaImage, dw: number, dh: number): RgbaImage {
  if (src.width === dw && src.height === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
      const from = (sy * src.width + sx) * 4;
      const to = (y * dw + x) * 4;
      out[to] = src.data[from];
      out[to + 1] = src.data[from + 1];
      out[to + 2] = src.data[from + 2];
      out[to + 3] = src.data[from + 3];
    }
  }
  return { width: dw, height: dh, data: out };
}

/** src-over composite of the overlay (class colours + alpha) onto the base. */
function compositeOver(base: RgbaImage, overlay: RgbaImage): RgbaImage {
  const out = new Uint8Array(base.width * base.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const alpha = overlay.data[i + 3] / 255;
    out[i] = Math.round(overlay.data[i] * alpha + base.data[i] * (1 - alpha));
    out[i + 1] = Math.round(overlay.data[i + 1] * alpha + base.data[i + 1] * (1 - alpha));
    out[i + 2] = Math.round(overlay.data[i + 2] * alpha + base.data[i + 2] * (1 - alpha));
    out[i + 3] = 255;
  }
  return { width: base.width, height: base.height, data: out };
}

/** Flattens RGBA onto the white backdrop (JPEG has no alpha channel). */
function flattenWhite(src: RgbaImage): Uint8Array {
  const rgb = new Uint8Array(src.width * src.height * 3);
  for (let i = 0, j = 0; i < src.data.length; i += 4, j += 3) {
    const alpha = src.data[i + 3] / 255;
    rgb[j] = Math.round(src.data[i] * alpha + FLATTEN[0] * (1 - alpha));
    rgb[j + 1] = Math.round(src.data[i + 1] * alpha + FLATTEN[1] * (1 - alpha));
    rgb[j + 2] = Math.round(src.data[i + 2] * alpha + FLATTEN[2] * (1 - alpha));
  }
  return rgb;
}

function encodeJpeg(image: RgbaImage, flattenAlpha: boolean): SummaryImage {
  const data = flattenAlpha ? flattenWhite(image) : toRgb(image);
  const encoded = jpeg.encode(
    { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), width: image.width, height: image.height },
    JPEG_QUALITY,
  );
  return { mimeType: "image/jpeg", data: encoded.data.toString("base64") };
}

function toRgb(image: RgbaImage): Uint8Array {
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let i = 0, j = 0; i < image.data.length; i += 4, j += 3) {
    rgb[j] = image.data[i];
    rgb[j + 1] = image.data[i + 1];
    rgb[j + 2] = image.data[i + 2];
  }
  return rgb;
}

/**
 * Builds the three preview images (date A, date B, overlay on date B).
 * Each render consumes one Process API unit unless the imagery cache hits.
 */
export async function buildSummaryImages(input: {
  geometry: ClipGeometry;
  dateA: string;
  dateB: string;
  overlayPng: Buffer;
}): Promise<SummaryImage[]> {
  const [imageA, imageB] = await Promise.all([
    renderPreview(input.geometry, input.dateA),
    renderPreview(input.geometry, input.dateB),
  ]);

  const overlayPng = PNG.sync.read(input.overlayPng);
  const overlay = scaleNearest(
    { width: overlayPng.width, height: overlayPng.height, data: new Uint8Array(overlayPng.data) },
    imageB.width,
    imageB.height,
  );

  const composite = compositeOver(imageB, overlay);

  return [
    encodeJpeg(imageA, true),
    encodeJpeg(imageB, true),
    encodeJpeg(composite, false), // already opaque
  ];
}
