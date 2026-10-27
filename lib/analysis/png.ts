/**
 * Hand-rolled PNG encoder (RGBA, filter 0) using node:zlib — no image
 * dependency needed for a single class-colour overlay. PNG structure:
 * signature | IHDR | IDAT (zlib of filtered scanlines) | IEND with CRC32.
 */
import { deflateSync } from "node:zlib";
import { CLASS, classColor } from "./config";

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
 *  - no-change / outside → fully transparent.
 * `width` is needed for the hatch phase.
 */
export function classToRgba(classGrid: Uint8Array, width: number): Uint8Array {
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
      const row = Math.floor(i / width);
      const col = i - row * width;
      const o = i * 4;
      rgba[o] = 165;
      rgba[o + 1] = 165;
      rgba[o + 2] = 165;
      rgba[o + 3] = (col + row) % 6 < 3 ? 170 : 80;
    }
    // no-change / outside stay 0,0,0,0
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
