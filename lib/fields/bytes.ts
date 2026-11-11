/**
 * Byte-level helpers for the PMTiles v3 format.
 *
 * readVarint/readVarintRemainder are ported byte-for-byte from the reference
 * implementation (protomaps/PMTiles, BSD) — the 6-byte remainder reader is
 * what keeps tile data offsets ≥ 2^31 exact (IN_RJ.pmtiles addresses tiles at
 * ~3.2 GB, beyond 32-bit float precision).
 */

export interface BufferPosition {
  buf: Uint8Array;
  pos: number;
}

function toNum(low: number, high: number): number {
  return (high >>> 0) * 0x100000000 + (low >>> 0);
}

function readVarintRemainder(l: number, p: BufferPosition): number {
  const buf = p.buf;
  let b = buf[p.pos++];
  let h = (b & 0x70) >> 4;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 3;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 10;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 17;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 24;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x01) << 31;
  if (b < 0x80) return toNum(l, h);
  throw new Error("Expected varint not more than 10 bytes");
}

/** Unsigned LEB128 varint; values ≥ 2^31 keep exact via readVarintRemainder. */
export function readVarint(p: BufferPosition): number {
  const buf = p.buf;
  let b = buf[p.pos++];
  let val = b & 0x7f;
  if (b < 0x80) return val;
  b = buf[p.pos++];
  val |= (b & 0x7f) << 7;
  if (b < 0x80) return val;
  b = buf[p.pos++];
  val |= (b & 0x7f) << 14;
  if (b < 0x80) return val;
  b = buf[p.pos++];
  val |= (b & 0x7f) << 21;
  if (b < 0x80) return val;
  b = buf[p.pos];
  val |= (b & 0x0f) << 28;
  return readVarintRemainder(val, p);
}

/**
 * Protocol-buffer zig-zag decoding (MVT geometry deltas, `sint64` values).
 * >>> keeps the unsigned interpretation for values above 2^31.
 */
export function zigzagDecode(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}
