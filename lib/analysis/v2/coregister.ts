/**
 * Phase 2.2 — integer sub-scene co-registration check.
 *
 * S2L2A tiles are nominally coregistered, but orbit/tile mosaics can sit a
 * pixel or two apart between dates — enough to smear patch edges and invent
 * slivers along boundaries (audit §2/§4). A coarse ±2 px search over strided
 * luminance with normalised cross-correlation detects a real misalignment;
 * the shift is applied to A (and its valid mask) only when it clearly beats
 * the zero-shift score.
 */
import type { BandSetLike } from "./normalize";

const STRIDE = 4;
const SEARCH_RADIUS = 2;
/** Minimum NCC improvement over (0,0) required before shifting anything. */
const MIN_IMPROVEMENT = 0.01;

export interface CoRegResult {
  dx: number;
  dy: number;
  score: number;
  zeroScore: number;
  applied: boolean;
}

/** Mean of the 7 optical bands as a coarse luminance proxy. */
function luminance(b: BandSetLike, out: Float32Array): void {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    out[i] =
      (b.b02[i] + b.b03[i] + b.b04[i] + b.b05[i] + b.b08[i] + b.b11[i] + b.b12[i]) / 7;
  }
}

/** Pearson correlation of A shifted by (dx, dy) against B over `mask` pixels. */
function ncc(
  la: Float32Array,
  lb: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let row = 0; row < height; row += STRIDE) {
    const sr = row + dy;
    if (sr < 0 || sr >= height) continue;
    for (let col = 0; col < width; col += STRIDE) {
      const sc = col + dx;
      if (sc < 0 || sc >= width) continue;
      const i = row * width + col;
      if (mask[i] !== 1) continue;
      const j = sr * width + sc;
      if (mask[j] !== 1) continue;
      const x = la[j];
      const y = lb[i];
      n += 1;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
  }
  if (n < 50) return 0;
  const cov = n * sxy - sx * sy;
  const vx = n * sxx - sx * sx;
  const vy = n * syy - sy * sy;
  if (vx <= 0 || vy <= 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/** Estimates the best integer shift (dx, dy) of A relative to B. */
export function estimateShift(
  a: BandSetLike,
  b: BandSetLike,
  mask: Uint8Array,
  width: number,
  height: number,
): CoRegResult {
  const la = new Float32Array(width * height);
  const lb = new Float32Array(width * height);
  luminance(a, la);
  luminance(b, lb);

  let bestDx = 0;
  let bestDy = 0;
  let best = -Infinity;
  let zeroScore = 0;
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      const score = ncc(la, lb, mask, width, height, dx, dy);
      if (dx === 0 && dy === 0) zeroScore = score;
      if (score > best) {
        best = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  const applied =
    (bestDx !== 0 || bestDy !== 0) && best > zeroScore + MIN_IMPROVEMENT;
  return {
    dx: applied ? bestDx : 0,
    dy: applied ? bestDy : 0,
    score: best === -Infinity ? 0 : best,
    zeroScore,
    applied,
  };
}

function clampIndex(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/** Applies (dx, dy) to A's bands and valid mask in place (clamped edges). */
export function applyShift(
  a: BandSetLike,
  validA: Uint8Array,
  dx: number,
  dy: number,
  width: number,
  height: number,
): void {
  if (dx === 0 && dy === 0) return;
  const bands = [a.b02, a.b03, a.b04, a.b05, a.b08, a.b11, a.b12];
  for (const band of bands) {
    const src = Float32Array.from(band); // snapshot: reads must not alias writes
    for (let row = 0; row < height; row++) {
      const sr = clampIndex(row + dy, height - 1);
      for (let col = 0; col < width; col++) {
        const sc = clampIndex(col + dx, width - 1);
        band[row * width + col] = src[sr * width + sc];
      }
    }
  }
  const vsrc = Uint8Array.from(validA);
  for (let row = 0; row < height; row++) {
    const sr = clampIndex(row + dy, height - 1);
    for (let col = 0; col < width; col++) {
      const sc = clampIndex(col + dx, width - 1);
      validA[row * width + col] = vsrc[sr * width + sc];
    }
  }
}
