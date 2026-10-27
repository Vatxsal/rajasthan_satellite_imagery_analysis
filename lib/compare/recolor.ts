import { CLASS, CLASS_DEFS, classColor } from "@/lib/analysis/config";

/**
 * Client-side overlay recolouring: the server PNG is fetched once per result
 * and kept as ImageData; class toggles and the "Boost visibility" display
 * filter (dilate small patches + theme outline) rebuild a blob-URL variant
 * that the map bridge swaps into the image source. No server round trip, no
 * second render — display-only: statistics and exports stay exact.
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

export interface OverlayDisplayOptions {
  /** Dilate change pixels by a grid-scaled radius + draw a contrast outline. */
  boost: boolean;
  /** Map theme — picks the outline colour (light outline on dark maps). */
  theme: "light" | "dark";
}

/** A recolour pass is needed for hidden classes and/or the boost filter. */
export function needsRecolor(
  classVisible: Record<number, boolean>,
  options: Pick<OverlayDisplayOptions, "boost">,
): boolean {
  return options.boost || !allClassesVisible(classVisible);
}

/** Dilation radius in image pixels: 1-3 px, scaled to the analysis grid size. */
export function boostRadius(width: number): number {
  return Math.max(1, Math.min(3, Math.round(width / 700)));
}

function outlineColor(theme: "light" | "dark"): [number, number, number] {
  // Light theme → near-black outline; dark theme → white outline.
  return theme === "light" ? [22, 24, 30] : [255, 255, 255];
}

function matchChangeClass(
  r: number,
  g: number,
  b: number,
  classVisible: Record<number, boolean>,
): boolean {
  for (const def of CLASS_DEFS) {
    if (!def.change || classVisible[def.code] === false) continue;
    const [cr, cg, cb] = def.color;
    if (r === cr && g === cg && b === cb) return true;
  }
  return false;
}

function matchChangeColorIndex(
  r: number,
  g: number,
  b: number,
  classVisible: Record<number, boolean>,
): number {
  let index = 0;
  for (const def of CLASS_DEFS) {
    if (!def.change) continue;
    const [cr, cg, cb] = def.color;
    if (r === cr && g === cg && b === cb) return index;
    index += 1;
  }
  return -1;
}

function changeColorList(classVisible: Record<number, boolean>): Array<[number, number, number]> {
  return CLASS_DEFS.filter((def) => def.change && classVisible[def.code] !== false).map(
    (def) => def.color,
  );
}

/**
 * Rebuilds the overlay: hidden classes become transparent, and (optionally)
 * the boost filter dilates visible change patches by a small radius — the
 * ring keeps the patch's own class colour at reduced alpha — then draws a
 * 1 px outline in the theme contrast colour. Change pixels themselves are
 * never altered.
 */
export async function buildOverlayBlobUrl(
  base: ImageData,
  classVisible: Record<number, boolean>,
  options: OverlayDisplayOptions,
): Promise<string | null> {
  const hiddenColors = TOGGLEABLE_CODES.filter(
    (code) => classVisible[code] === false && code !== CLASS.masked,
  ).map((code) => classColor(code));
  const hideMasked = classVisible[CLASS.masked] === false;
  if (hiddenColors.length === 0 && !hideMasked && !options.boost) return null;

  const width = base.width;
  const height = base.height;
  const data = new ImageData(new Uint8ClampedArray(base.data), width, height);
  const pixels = data.data;
  const n = width * height;

  // 1. apply class visibility
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (pixels[o + 3] === 0) continue;
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    let hide = hideMasked && r === g && g === b;
    if (!hide) {
      for (const color of hiddenColors) {
        if (r === color[0] && g === color[1] && b === color[2]) {
          hide = true;
          break;
        }
      }
    }
    if (hide) pixels[o + 3] = 0;
  }

  if (!options.boost) {
    // Nothing left to do — hand the work to the canvas below.
  } else {
    const colors = changeColorList(classVisible);
    const colorIndexOf = (i: number): number =>
      matchChangeColorIndex(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2], classVisible);

    // 2. change mask (visible, toggleable change classes only)
    const changeMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (pixels[o + 3] === 0) continue;
      if (
        matchChangeClass(pixels[o], pixels[o + 1], pixels[o + 2], classVisible)
      ) {
        changeMask[i] = 1;
      }
    }

    const hasChange = changeMask.some((v) => v === 1);
    if (hasChange) {
      const radius = boostRadius(width);
      // 3. dilate: every change pixel paints its colour into a (2R+1)² window
      const dilated = new Uint8Array(n);
      const dilatedColor = new Int16Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        if (changeMask[i] === 0) continue;
        const ci = colorIndexOf(i);
        const col = i % width;
        const row = (i - col) / width;
        const c0 = Math.max(0, col - radius);
        const c1 = Math.min(width - 1, col + radius);
        const r0 = Math.max(0, row - radius);
        const r1 = Math.min(height - 1, row + radius);
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const j = r * width + c;
            dilated[j] = 1;
            if (dilatedColor[j] < 0) dilatedColor[j] = ci;
          }
        }
      }

      const [or, og, ob] = outlineColor(options.theme);

      // 4. ring (dilated minus original) in the patch colour, 5. outline
      for (let i = 0; i < n; i++) {
        if (dilated[i] === 0 || changeMask[i] === 1) continue;
        const ci = dilatedColor[i];
        const color = ci >= 0 && ci < colors.length ? colors[ci] : colors[0];
        if (!color) continue;
        const o = i * 4;
        pixels[o] = color[0];
        pixels[o + 1] = color[1];
        pixels[o + 2] = color[2];
        pixels[o + 3] = 110;
      }

      for (let i = 0; i < n; i++) {
        if (dilated[i] === 0) continue;
        const col = i % width;
        const row = (i - col) / width;
        let boundary = false;
        if (col > 0 && dilated[i - 1] === 0) boundary = true;
        else if (col < width - 1 && dilated[i + 1] === 0) boundary = true;
        else if (row > 0 && dilated[i - width] === 0) boundary = true;
        else if (row < height - 1 && dilated[i + width] === 0) boundary = true;
        if (!boundary) continue;
        const o = i * 4;
        pixels[o] = or;
        pixels[o + 1] = og;
        pixels[o + 2] = ob;
        pixels[o + 3] = 230;
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}
