/**
 * Tiny classic-TIFF IFD rewriter used to stamp Sentinel Hub GeoTIFF downloads
 * with metadata the Process API cannot write for us: band descriptions
 * (GDAL_METADATA, tag 42112) + declared nodata (GDAL_NODATA, tag 42113) for the
 * analysis file, and RGB+alpha interpretation (Photometric/ExtraSamples) + a
 * nodata value for the visual file.
 *
 * It never rewrites existing bytes: the original image data and IFD stay where
 * they are, a rebuilt IFD (with our two tags merged in) is appended at the end
 * of the file and the header's "first IFD" pointer is repointed at it. So every
 * existing offset — StripOffsets, GeoTIFF keys, colour tables — stays valid.
 *
 * BigTIFF / unrecognised files are returned untouched: a wrong-but-valid file
 * would be far worse than one missing a description.
 */

const TAG_GDAL_METADATA = 42112; // XML band metadata (byte array)
const TAG_GDAL_NODATA = 42113; // ASCII nodata value
const TAG_PHOTOMETRIC = 262;
const TAG_EXTRA_SAMPLES = 338;
const TAG_SAMPLES_PER_PIXEL = 277;

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_UNDEFINED = 7;

export interface GeoTiffMetadataPatch {
  /** One label per band, written as GDAL band descriptions. */
  bandDescriptions?: readonly string[];
  /** Declared nodata value applied to every band, e.g. "-9999". */
  nodata?: string;
  /**
   * Promote a 4-band 8-bit file to RGB + unassociated alpha
   * (PhotometricInterpretation 1→2, ExtraSamples 2) so GDAL/QGIS treat band 4
   * as transparency instead of an ordinary band.
   */
  rgba?: boolean;
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw 4-byte value/offset field, exactly as it appeared in the file. */
  raw: Buffer;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildBandMetadataXml(descriptions: readonly string[]): Buffer {
  const items = descriptions
    .map(
      (description, index) =>
        `  <Item name="DESCRIPTION" sample="${index}" role="description">${escapeXml(description)}</Item>`,
    )
    .join("\n");
  return Buffer.from(`<GDALMetadata>\n${items}\n</GDALMetadata>\n`, "utf8");
}

/** TIFF values of at most 4 bytes are stored inline, not behind an offset. */
function valueFieldFor(payload: Buffer, offset: number, littleEndian: boolean): Buffer {
  const field = Buffer.alloc(4);
  if (payload.length <= 4) payload.copy(field, 0);
  else (littleEndian ? field.writeUInt32LE : field.writeUInt32BE).call(field, offset, 0);
  return field;
}

function readEntry(buffer: Buffer, at: number, littleEndian: boolean): IfdEntry {
  const u16 = littleEndian ? buffer.readUInt16LE : buffer.readUInt16BE;
  const u32 = littleEndian ? buffer.readUInt32LE : buffer.readUInt32BE;
  return {
    tag: u16.call(buffer, at),
    type: u16.call(buffer, at + 2),
    count: u32.call(buffer, at + 4),
    raw: buffer.subarray(at + 8, at + 12),
  };
}

function writeEntry(
  buffer: Buffer,
  at: number,
  entry: IfdEntry,
  littleEndian: boolean,
): void {
  const putU16 = littleEndian ? buffer.writeUInt16LE : buffer.writeUInt16BE;
  const putU32 = littleEndian ? buffer.writeUInt32LE : buffer.writeUInt32BE;
  putU16.call(buffer, entry.tag, at);
  putU16.call(buffer, entry.type, at + 2);
  putU32.call(buffer, entry.count, at + 4);
  entry.raw.copy(buffer, at + 8);
}

/**
 * Stamps `patch` onto a GeoTIFF and returns the new buffer.
 * Returns the input unchanged (never throws) when the file cannot be safely
 * patched.
 */
export function withGeoTiffMetadata(
  buffer: Buffer,
  patch: GeoTiffMetadataPatch,
): Buffer {
  const hasDescriptions = (patch.bandDescriptions?.length ?? 0) > 0;
  const hasNodata = typeof patch.nodata === "string" && patch.nodata.length > 0;
  const hasRgba = patch.rgba === true;
  if (!hasDescriptions && !hasNodata && !hasRgba) return buffer;
  if (buffer.length < 8) return buffer;

  const byteOrder = buffer.toString("latin1", 0, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") return buffer;
  const littleEndian = byteOrder === "II";
  const u16 = littleEndian ? buffer.readUInt16LE : buffer.readUInt16BE;
  const u32 = littleEndian ? buffer.readUInt32LE : buffer.readUInt32BE;

  const magic = u16.call(buffer, 2);
  if (magic !== 42) return buffer; // BigTIFF (43) or unknown → leave alone.

  const ifdOffset = u32.call(buffer, 4);
  if (ifdOffset + 2 > buffer.length) return buffer;

  const entryCount = u16.call(buffer, ifdOffset);
  const entriesEnd = ifdOffset + 2 + entryCount * 12;
  if (entriesEnd + 4 > buffer.length) return buffer;

  const existing: IfdEntry[] = [];
  let photometricEntry: IfdEntry | undefined;
  let extraSamplesIndex = -1;
  for (let i = 0; i < entryCount; i++) {
    const entry = readEntry(buffer, ifdOffset + 2 + i * 12, littleEndian);
    if (entry.tag === TAG_GDAL_METADATA || entry.tag === TAG_GDAL_NODATA) continue;
    if (entry.tag === TAG_PHOTOMETRIC) photometricEntry = entry;
    if (entry.tag === TAG_EXTRA_SAMPLES) extraSamplesIndex = existing.length;
    existing.push(entry);
  }

  // ---- payload appended past the end of the original file -----------------
  const chunks: Buffer[] = [];
  let cursor = buffer.length;
  const align = () => {
    if (cursor % 2 === 1) {
      chunks.push(Buffer.from([0]));
      cursor += 1;
    }
  };

  const appended: IfdEntry[] = [];

  if (hasNodata) {
    align();
    const payload = Buffer.from(`${patch.nodata}\0`, "ascii");
    const offset = cursor;
    chunks.push(payload);
    cursor += payload.length;
    appended.push({
      tag: TAG_GDAL_NODATA,
      type: TYPE_ASCII,
      count: payload.length,
      raw: valueFieldFor(payload, offset, littleEndian),
    });
  }

  if (hasDescriptions) {
    align();
    const payload = buildBandMetadataXml(patch.bandDescriptions!);
    const offset = cursor;
    chunks.push(payload);
    cursor += payload.length;
    appended.push({
      tag: TAG_GDAL_METADATA,
      type: TYPE_BYTE,
      count: payload.length,
      raw: valueFieldFor(payload, offset, littleEndian),
    });
  }

  const shortField = (value: number): Buffer => {
    const raw = Buffer.alloc(4);
    (littleEndian ? raw.writeUInt16LE : raw.writeUInt16BE).call(raw, value, 0);
    return raw;
  };
  const inlineShort = (entry?: IfdEntry): number | undefined =>
    entry && entry.type === TYPE_SHORT && entry.count === 1
      ? (littleEndian ? entry.raw.readUInt16LE : entry.raw.readUInt16BE).call(entry.raw, 0)
      : undefined;

  if (
    hasRgba &&
    inlineShort(existing.find((entry) => entry.tag === TAG_SAMPLES_PER_PIXEL)) === 4 &&
    photometricEntry?.type === TYPE_SHORT &&
    photometricEntry.count === 1 &&
    inlineShort(photometricEntry) === 1 // BlackIsZero → promote to RGB
  ) {
    existing[existing.indexOf(photometricEntry)] = {
      tag: TAG_PHOTOMETRIC,
      type: TYPE_SHORT,
      count: 1,
      raw: shortField(2),
    };
    const extraSamples: IfdEntry = {
      tag: TAG_EXTRA_SAMPLES,
      type: TYPE_SHORT,
      count: 1,
      raw: shortField(2), // 2 = unassociated alpha
    };
    if (extraSamplesIndex >= 0) existing[extraSamplesIndex] = extraSamples;
    else appended.push(extraSamples);
  }

  const all = [...existing, ...appended].sort((a, b) => a.tag - b.tag);

  align();
  const newIfdOffset = cursor;
  const ifdSize = 2 + all.length * 12 + 4;
  if (newIfdOffset + ifdSize > 0xffff_ffff) return buffer;

  const ifd = Buffer.alloc(ifdSize);
  const putU16 = (littleEndian ? ifd.writeUInt16LE : ifd.writeUInt16BE).bind(ifd);
  const putU32 = (littleEndian ? ifd.writeUInt32LE : ifd.writeUInt32BE).bind(ifd);
  putU16(all.length, 0);
  all.forEach((entry, index) => writeEntry(ifd, 2 + index * 12, entry, littleEndian));
  // Keep the original page chain (multi-page TIFFs stay multi-page).
  putU32(u32.call(buffer, entriesEnd), 2 + all.length * 12);
  chunks.push(ifd);

  const header = Buffer.from(buffer.subarray(0, 8));
  (littleEndian ? header.writeUInt32LE : header.writeUInt32BE).call(
    header,
    newIfdOffset,
    4,
  );

  return Buffer.concat([header, buffer.subarray(8), ...chunks]);
}

/** Exposed for tests — the two tags this module owns. */
export const GDAL_TAGS = {
  metadata: TAG_GDAL_METADATA,
  nodata: TAG_GDAL_NODATA,
  types: { byte: TYPE_BYTE, ascii: TYPE_ASCII, undefined: TYPE_UNDEFINED },
} as const;
