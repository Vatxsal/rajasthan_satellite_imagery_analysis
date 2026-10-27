import { CLASS, CLASS_DEFS, classColor } from "@/lib/analysis/config";

/**
 * Client-side overlay recolouring: the server PNG is fetched once per result
 * and kept as ImageData; toggling a class rebuilds a transparent-pixel variant
 * (blob URL) that the map bridge swaps into the image source. No server round
 * trip, no second render.
 */

const baseCache = new Map<string, Promise<ImageData>>();
const MAX_CACHE = 4;

async function fetchOverlayImageData(url: string): Promise<ImageData> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Could not load the change map image.");
  }
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Canvas is unavailable in this browser.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Cached base pixels per analysis key (re-fetch only when the cache evicts). */
export function loadOverlayImageData(key: string, url: string): Promise<ImageData> {
  const cached = baseCache.get(key);
  if (cached) return cached;
  const pending = fetchOverlayImageData(url);
  baseCache.set(key, pending);
  pending.catch(() => baseCache.delete(key));
  if (baseCache.size > MAX_CACHE) {
    const oldest = baseCache.keys().next().value;
    if (oldest !== undefined) baseCache.delete(oldest);
  }
  return pending;
}

/** Toggleable class codes (change classes + masked). No-change stays transparent. */
export const TOGGLEABLE_CODES: readonly number[] = CLASS_DEFS.filter(
  (def) => def.code !== CLASS.noChange,
).map((def) => def.code);

export function allClassesVisible(classVisible: Record<number, boolean>): boolean {
  return TOGGLEABLE_CODES.every((code) => classVisible[code] !== false);
}

/**
 * Rebuilds the overlay with hidden classes made transparent.
 * Change classes match their exact RGB; masked pixels are a grey hatch
 * (r === g === b), so grey is matched by value instead.
 */
export async function buildOverlayBlobUrl(
  base: ImageData,
  classVisible: Record<number, boolean>,
): Promise<string | null> {
  const hiddenColors = TOGGLEABLE_CODES.filter(
    (code) => classVisible[code] === false && code !== CLASS.masked,
  ).map((code) => classColor(code));
  const hideMasked = classVisible[CLASS.masked] === false;
  if (hiddenColors.length === 0 && !hideMasked) return null;

  const data = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    let hide = hideMasked && r === g && g === b;
    if (!hide) {
      for (const color of hiddenColors) {
        if (r === color[0] && g === color[1] && b === color[2]) {
          hide = true;
          break;
        }
      }
    }
    if (hide) pixels[i + 3] = 0;
  }

  const canvas = document.createElement("canvas");
  canvas.width = base.width;
  canvas.height = base.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}
