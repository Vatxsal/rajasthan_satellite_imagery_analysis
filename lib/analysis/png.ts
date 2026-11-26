/**
 * Hand-rolled PNG encoder (RGBA, filter 0) using node:zlib — no image
 * dependency needed for a single class-colour overlay. PNG structure:
 * signature | IHDR | IDAT (zlib of filtered scanlines) | IEND with CRC32.
 */
import { deflateSync } from "node:zlib";
import { CLASS, MAGNITUDE_SCALE, classColor } from "./config";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/**
 * Classifies codes → RGBA:
 *  - change classes → class colour, opaque;
 *  - masked (6) → grey with a diagonal hatch, semi-transparent;
 *  - no-change / outside → fully transparent (or, with `showUnchanged`,
 *    no-change → a subtle green tint so "analysed, nothing changed" is
 *    visibly distinct from "not analysed"; outside stays transparent).
 * `width` is needed for the hatch phase.
 */
export function classToRgba(
  classGrid: Uint8Array,
  width: number,
  options: { showUnchanged?: boolean } = {},
): Uint8Array {
  const rgba = new Uint8Array(classGrid.length * 4);
  for (let i = 0; i < classGrid.length; i++) {
    const code = classGrid[i];
    if (code >= CLASS.vegGain && code <= CLASS.waterLoss) {
      const [r, g, b] = classColor(code);
      const o = i * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    } else if (code === CLASS.masked) {
      paintMaskedHatch(rgba, i, width);
    } else if (code === CLASS.noChange && options.showUnchanged) {
      const o = i * 4;
      rgba[o] = 118;
      rgba[o + 1] = 148;
      rgba[o + 2] = 118;
      rgba[o + 3] = 90;
    }
    // no-change (transparent mode) / outside stay 0,0,0,0
  }
  return rgba;
}

/** Grey diagonal hatch on a masked pixel (shared by every layer renderer). */
function paintMaskedHatch(rgba: Uint8Array, i: number, width: number): void {
  const row = Math.floor(i / width);
  const col = i - row * width;
  const o = i * 4;
  rgba[o] = 165;
  rgba[o + 1] = 165;
  rgba[o + 2] = 165;
  rgba[o + 3] = (col + row) % 6 < 3 ? 170 : 80;
}

/**
 * Phase 1 — coverage-reason raster → RGBA (COVERAGE_REASON codes):
 * analysed gets a subtle green tint so the covered area reads as covered;
 * the failure reasons get strong, distinguishable colours; outside is
 * transparent.
 */
export function coverageToRgba(coverage: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(coverage.length * 4);
  for (let i = 0; i < coverage.length; i++) {
    const o = i * 4;
    switch (coverage[i]) {
      case 0: // analysed both dates
        rgba[o] = 110;
        rgba[o + 1] = 160;
        rgba[o + 2] = 110;
        rgba[o + 3] = 60;
        break;
      case 1: // date A missing
        rgba[o] = 220;
        rgba[o + 1] = 38;
        rgba[o + 2] = 38;
        rgba[o + 3] = 175;
        break;
      case 2: // date B missing
        rgba[o] = 249;
        rgba[o + 1] = 115;
        rgba[o + 2] = 22;
        rgba[o + 3] = 175;
        break;
      case 3: // cloud / shadow
        rgba[o] = 234;
        rgba[o + 1] = 179;
        rgba[o + 2] = 8;
        rgba[o + 3] = 170;
        break;
      case 4: // unknown (no breakdown available)
        rgba[o] = 148;
        rgba[o + 1] = 163;
        rgba[o + 2] = 184;
        rgba[o + 3] = 165;
        break;
      default: // outside → transparent
        break;
    }
  }
  return rgba;
}

/**
 * Phase 1 — gap-fill source raster → RGBA: pixels only analysed thanks to
 * the ±window rescue render get a sky-blue tint; masked stays the grey
 * hatch, outside transparent, untouched pixels transparent.
 */
export function gapFillToRgba(source: Uint8Array, classGrid: Uint8Array, width: number): Uint8Array {
  const rgba = new Uint8Array(source.length * 4);
  for (let i = 0; i < source.length; i++) {
    const code = classGrid[i];
    if (code === CLASS.outside) continue;
    if (code === CLASS.masked) {
      paintMaskedHatch(rgba, i, width);
      continue;
    }
    if (source[i] !== 1) continue;
    const o = i * 4;
    rgba[o] = 56;
    rgba[o + 1] = 189;
    rgba[o + 2] = 248;
    rgba[o + 3] = 175;
  }
  return rgba;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * Phase 1 — Δ-index magnitude plane (int8, MAGNITUDE_SCALE) → RGBA.
 *  - "signed"   (ΔNDVI / ΔMNDWI / ΔNDBI): diverging white→blue (negative)
 *               / white→red (positive); near-zero deltas stay transparent.
 *  - "combined" (max |Δ|/threshold, dominant sign ignored): sequential
 *               white→amber→red ramp by strength.
 * Masked pixels keep the grey hatch; outside is transparent — so masked vs
 * unchanged-vs-analysed stays readable under every layer.
 */
export function magnitudeToRgba(
  plane: Int8Array,
  classGrid: Uint8Array,
  width: number,
  mode: "signed" | "combined",
): Uint8Array {
  const rgba = new Uint8Array(plane.length * 4);
  for (let i = 0; i < plane.length; i++) {
    const code = classGrid[i];
    if (code === CLASS.outside) continue;
    if (code === CLASS.masked) {
      paintMaskedHatch(rgba, i, width);
      continue;
    }
    const v = plane[i] / MAGNITUDE_SCALE;
    const o = i * 4;
    if (mode === "signed") {
      const strength = Math.min(1, Math.abs(v));
      if (strength < 0.05) continue; // below every applied threshold
      const positive = v > 0;
      const alpha = Math.round(Math.min(235, 60 + strength * 175));
      rgba[o] = lerp(255, positive ? 239 : 59, strength);
      rgba[o + 1] = lerp(250, positive ? 68 : 130, strength);
      rgba[o + 2] = lerp(245, positive ? 68 : 246, strength);
      rgba[o + 3] = alpha;
    } else {
      const t = Math.min(1, Math.abs(v) / 2);
      if (t < 0.03) continue;
      if (t <= 0.5) {
        const k = t * 2;
        rgba[o] = lerp(255, 245, k);
        rgba[o + 1] = lerp(250, 158, k);
        rgba[o + 2] = lerp(245, 11, k);
      } else {
        const k = (t - 0.5) * 2;
        rgba[o] = lerp(245, 185, k);
        rgba[o + 1] = lerp(158, 28, k);
        rgba[o + 2] = lerp(11, 28, k);
      }
      rgba[o + 3] = Math.round(Math.min(240, 40 + t * 220));
    }
  }
  return rgba;
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const srcStart = row * stride;
    const dstStart = row * (stride + 1);
    raw[dstStart] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + srcStart, stride).copy(raw, dstStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
