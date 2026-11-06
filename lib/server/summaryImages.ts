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
async function renderPreview(
  geometry: ClipGeometry,
  date: string,
  size: number = SUMMARY_IMAGE_MAX_PX,
): Promise<RgbaImage> {
  const env = getServerEnv();
  const key = imageryCacheKey({
    geometry,
    date,
    composite: "true-color",
    size,
    format: "png",
  });
  let png = imageryCache.get(key);
  if (!png) {
    png = await renderSceneImage({
      geometry,
      date,
      composite: "true-color",
      maxSize: size,
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
  return {
    mimeType: "image/jpeg",
    data: encodeJpegBuffer(image, JPEG_QUALITY, flattenAlpha).toString("base64"),
  };
}

function encodeJpegBuffer(image: RgbaImage, quality: number, flattenAlpha: boolean): Buffer {
  const data = flattenAlpha ? flattenWhite(image) : toRgb(image);
  const encoded = jpeg.encode(
    { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), width: image.width, height: image.height },
    quality,
  );
  return encoded.data;
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

export interface ChangeMapJpeg {
  /** Raw JPEG bytes (the email route base64s them for the CID attachment). */
  content: Buffer;
  width: number;
  height: number;
}

/**
 * Change-map JPEG for the emailed report: classified overlay composited over
 * the date-B true-colour render, long side ≤ maxPx (spec: 700), quality
 * stepped down (then the image scaled) until it fits maxBytes — the HTML
 * budget forces the inline base64 image to stay small. Returns null when even
 * the smallest attempt cannot fit; callers drop the image rather than fail
 * the send.
 */
export async function buildChangeMapJpeg(input: {
  geometry: ClipGeometry;
  dateB: string;
  overlayPng: Buffer;
  maxPx?: number;
  maxBytes?: number;
}): Promise<ChangeMapJpeg | null> {
  const maxPx = input.maxPx ?? 700;
  const maxBytes = input.maxBytes ?? 30_000;
  if (maxBytes < 4_000) return null;

  const base = await renderPreview(input.geometry, input.dateB, maxPx);
  const overlayPng = PNG.sync.read(input.overlayPng);
  const overlay = scaleNearest(
    { width: overlayPng.width, height: overlayPng.height, data: new Uint8Array(overlayPng.data) },
    base.width,
    base.height,
  );
  let composite = compositeOver(base, overlay);

  for (const quality of [80, 60, 45, 30]) {
    const encoded = encodeJpegBuffer(composite, quality, false);
    if (encoded.byteLength <= maxBytes) {
      return { content: encoded, width: composite.width, height: composite.height };
    }
  }

  // Still too big: shrink once per pass until the budget fits or we give up.
  for (const factor of [0.75, 0.55, 0.4]) {
    const width = Math.max(240, Math.round(composite.width * factor));
    const height = Math.max(240, Math.round(composite.height * factor));
    composite = scaleNearest(composite, width, height);
    for (const quality of [60, 40]) {
      const encoded = encodeJpegBuffer(composite, quality, false);
      if (encoded.byteLength <= maxBytes) {
        return { content: encoded, width, height };
      }
    }
  }
  return null;
}
