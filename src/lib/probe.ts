/**
 * Read an image's format and dimensions from its header, without decoding it.
 *
 * This exists so that a 453 megapixel PNG is identified as a 453 megapixel PNG
 * *before* anything tries to allocate 1.8 GB for it. Every decision downstream
 * — which decode strategy to use, whether to refuse the file, how much of the
 * worker pool's pixel budget to reserve — depends on knowing the size up front.
 */

export type ImageKind =
  | "jpeg"
  | "png"
  | "heic"
  | "avif"
  | "tiff"
  | "webp"
  | "gif";

export interface ProbeResult {
  kind: ImageKind;
  width: number;
  height: number;
  /** width * height / 1e6, for budgeting and for messages to the user. */
  megapixels: number;
}

/** Enough for a JPEG's SOF marker even behind a fat EXIF/ICC block. */
export const PROBE_BYTES = 128 * 1024;

/**
 * A file we can read arbitrary slices of. TIFF needs this: it stores its
 * directory wherever it likes, and real scanner output routinely puts it after
 * the image data — the Ferrwood scans have it at byte 70,832,394 of a 68 MB
 * file, so a fixed-size read of the front finds nothing.
 */
export interface ByteRangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

const ascii = (b: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...b.subarray(at, at + len));

function result(kind: ImageKind, width: number, height: number): ProbeResult {
  return { kind, width, height, megapixels: (width * height) / 1e6 };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Parse a leading slice of a file. Returns null if the format is unrecognised,
 * the header is truncated, or (for TIFF) the directory sits outside the slice —
 * use `probe` for the general case.
 */
export function probeBytes(bytes: Uint8Array): ProbeResult | null {
  if (bytes.length < 16) return null;
  const view = viewOf(bytes);

  if (bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpeg(bytes, view);

  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") {
    // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) w(4) h(4).
    if (ascii(bytes, 12, 4) !== "IHDR") return null;
    return result("png", view.getUint32(16), view.getUint32(20));
  }

  if (ascii(bytes, 0, 4) === "GIF8") {
    return result("gif", view.getUint16(6, true), view.getUint16(8, true));
  }

  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return probeWebp(bytes, view);
  }

  const tiff = tiffHeader(bytes, view);
  if (tiff) {
    return tiff.ifdOffset + 2 <= bytes.length
      ? readTiffIfd(view, tiff.ifdOffset, tiff.littleEndian)
      : null;
  }

  if (ascii(bytes, 4, 4) === "ftyp") return probeIsoBmff(bytes, view);

  return null;
}

/** Probe any readable byte range, following TIFF's directory pointer. */
export async function probe(
  reader: ByteRangeReader
): Promise<ProbeResult | null> {
  if (reader.size < 16) return null;
  const head = await reader.read(0, Math.min(PROBE_BYTES, reader.size));

  const direct = probeBytes(head);
  if (direct) return direct;

  const tiff = tiffHeader(head, viewOf(head));
  if (!tiff || tiff.ifdOffset + 2 > reader.size) return null;

  // Read from the directory itself. 64 KB covers far more entries than any
  // real file has, and we only care about two of them.
  const length = Math.min(64 * 1024, reader.size - tiff.ifdOffset);
  const slice = await reader.read(tiff.ifdOffset, length);
  return readTiffIfd(viewOf(slice), 0, tiff.littleEndian);
}

export function blobReader(blob: Blob): ByteRangeReader {
  return {
    size: blob.size,
    async read(offset, length) {
      const buf = await blob.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

export function bytesReader(bytes: Uint8Array): ByteRangeReader {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length);
    },
  };
}

/**
 * Walk the JPEG marker chain to the frame header. The dimensions live in the
 * SOFn segment, which sits after any EXIF, ICC and thumbnail data — so this
 * cannot be read from a fixed offset.
 */
function probeJpeg(bytes: Uint8Array, view: DataView): ProbeResult | null {
  let p = 2;
  while (p + 9 < bytes.length) {
    if (bytes[p] !== 0xff) {
      p++; // Resync past padding rather than giving up.
      continue;
    }
    const marker = bytes[p + 1]!;
    // Standalone markers carry no length payload.
    if (
      marker === 0xff ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd9)
    ) {
      p += 2;
      continue;
    }
    // SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
    const isFrameHeader =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrameHeader) {
      return result("jpeg", view.getUint16(p + 7), view.getUint16(p + 5));
    }
    // Start of scan: pixel data follows, so the header is behind us.
    if (marker === 0xda) return null;
    p += 2 + view.getUint16(p + 2);
  }
  return null;
}

function probeWebp(bytes: Uint8Array, view: DataView): ProbeResult | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return result("webp", w, h);
  }
  if (chunk === "VP8 ") {
    // Lossy: 3-byte frame tag, 3-byte start code, then 14-bit w/h.
    return result(
      "webp",
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff
    );
  }
  if (chunk === "VP8L") {
    // Lossless: 14 bits of width-1 then 14 bits of height-1, little-endian.
    const bits = view.getUint32(21, true);
    return result("webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

function tiffHeader(
  bytes: Uint8Array,
  view: DataView
): { littleEndian: boolean; ifdOffset: number } | null {
  const bom = ascii(bytes, 0, 2);
  if (bom !== "II" && bom !== "MM") return null;
  const littleEndian = bom === "II";
  const magic = view.getUint16(2, littleEndian);
  // 43 is BigTIFF, which uses 8-byte offsets and a different entry layout.
  // Nothing in scope produces it; report unknown rather than mis-parse.
  if (magic !== 42) return null;
  return { littleEndian, ifdOffset: view.getUint32(4, littleEndian) };
}

function readTiffIfd(
  view: DataView,
  ifdAt: number,
  le: boolean
): ProbeResult | null {
  if (ifdAt + 2 > view.byteLength) return null;
  const count = view.getUint16(ifdAt, le);
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const entry = ifdAt + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, le);
    if (tag !== 256 && tag !== 257) continue;
    const type = view.getUint16(entry + 2, le);
    // SHORT occupies the first 2 bytes of the value field, LONG all 4.
    const value =
      type === 3 ? view.getUint16(entry + 8, le) : view.getUint32(entry + 8, le);
    if (tag === 256) width = value;
    else height = value;
  }
  return width && height ? result("tiff", width, height) : null;
}

/**
 * HEIC and AVIF are both ISO-BMFF. Rather than walking the full box tree down
 * to the primary item, scan for `ispe` (image spatial extents) boxes and take
 * the largest — thumbnails and alpha planes produce extra ones, and for a
 * memory budget the worst case is the number we want anyway.
 */
function probeIsoBmff(bytes: Uint8Array, view: DataView): ProbeResult | null {
  const brand = ascii(bytes, 8, 4);
  const kind: ImageKind = brand === "avif" || brand === "avis" ? "avif" : "heic";

  let best: { w: number; h: number } | null = null;
  for (let p = 0; p + 20 <= bytes.length; p++) {
    if (
      bytes[p] !== 0x69 || // i
      bytes[p + 1] !== 0x73 || // s
      bytes[p + 2] !== 0x70 || // p
      bytes[p + 3] !== 0x65 // e
    ) {
      continue;
    }
    // "ispe" then version+flags(4), width(4), height(4).
    const w = view.getUint32(p + 8);
    const h = view.getUint32(p + 12);
    if (w === 0 || h === 0 || w > 500_000 || h > 500_000) continue;
    if (!best || w * h > best.w * best.h) best = { w, h };
  }
  return best ? result(kind, best.w, best.h) : null;
}
