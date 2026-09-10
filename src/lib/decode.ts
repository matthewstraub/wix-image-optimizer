/**
 * Decode any supported input to sRGB RGBA pixels, in display orientation.
 *
 * The browser's own decoder is the primary path, and that choice is about
 * colour, not convenience. `createImageBitmap` applies the embedded ICC
 * profile and converts into the canvas colour space; the jSquash codecs hand
 * back raw channel values with the profile ignored. Feed an AdobeRGB export
 * through the latter and it arrives flat and desaturated — the classic "my
 * photos look dull on the website" bug, baked in at the first step.
 *
 * It also handles the EXIF Orientation tag for us, which matters because we
 * strip metadata: a portrait frame whose rotation lived only in EXIF would
 * otherwise ship sideways.
 *
 * jSquash and libheif are fallbacks, for formats the browser will not decode.
 */

import { FULL_DECODE_MAX_MEGAPIXELS } from "./budget";
import type { ImageKind, ProbeResult } from "./probe";
import type { RgbaImage } from "./unsharp";

export class UnsupportedImageError extends Error {}

export interface DecodeRequest {
  blob: Blob;
  meta: ProbeResult;
  /** Final output size, so an oversized source can be scaled during decode. */
  target: { width: number; height: number };
}

/**
 * Formats every current browser decodes natively. HEIC is deliberately absent:
 * Safari manages it, Chrome and Firefox do not, so it is attempted and then
 * falls back.
 */
const NATIVE: ReadonlySet<ImageKind> = new Set<ImageKind>([
  "jpeg",
  "png",
  "webp",
  "avif",
  "gif",
]);

export async function decodeToRgba(request: DecodeRequest): Promise<RgbaImage> {
  const { meta } = request;

  if (NATIVE.has(meta.kind) || meta.kind === "heic") {
    try {
      return await decodeNative(request);
    } catch (error) {
      if (NATIVE.has(meta.kind)) throw error;
      // HEIC on Chrome/Firefox lands here.
    }
  }

  if (meta.kind === "heic") return decodeHeic(request);
  if (meta.kind === "tiff") return decodeTiff(request);
  throw new UnsupportedImageError(`Cannot decode ${meta.kind} in the browser`);
}

/**
 * How big to decode at. Anything comfortably small is decoded at full size and
 * resampled properly afterwards. Above that we ask the decoder for roughly
 * twice the final size, which lets a JPEG use DCT shrink-on-load and keeps
 * peak memory flat — a 45 megapixel frame is 180 MB of RGBA at full size and
 * about 20 MB at 2x a 2560px target. The remaining 2x reduction still goes
 * through Lanczos3, so the quality cost is small; bench/run.ts carries an arm
 * that measures it.
 */
export function decodeSize(
  meta: ProbeResult,
  target: { width: number; height: number }
): { width: number; height: number } | null {
  if (meta.megapixels <= FULL_DECODE_MAX_MEGAPIXELS) return null;
  const scale = Math.min(
    1,
    Math.max((target.width * 2) / meta.width, (target.height * 2) / meta.height)
  );
  if (scale >= 1) return null;
  return {
    width: Math.max(1, Math.round(meta.width * scale)),
    height: Math.max(1, Math.round(meta.height * scale)),
  };
}

async function decodeNative(request: DecodeRequest): Promise<RgbaImage> {
  const staged = decodeSize(request.meta, request.target);
  // `imageOrientation` consumes the EXIF tag; `resizeWidth`/`resizeHeight`
  // let the decoder scale as it goes rather than after.
  const options: ImageBitmapOptions = { imageOrientation: "from-image" };
  if (staged) {
    // The tag may say the frame is rotated, in which case the staged size,
    // derived from header dimensions, is the other way round. Ask for the
    // larger of the two and let aspect ratio settle it.
    options.resizeWidth = Math.max(staged.width, staged.height);
    options.resizeQuality = "high";
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(request.blob, options);
  } catch {
    // Older Safari rejects the whole call on unknown options rather than
    // ignoring them, so retry without the staging hints.
    bitmap = await createImageBitmap(request.blob, {
      imageOrientation: "from-image",
    });
  }

  try {
    return bitmapToRgba(bitmap);
  } finally {
    bitmap.close();
  }
}

function bitmapToRgba(bitmap: ImageBitmap): RgbaImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  // An explicit sRGB context is what makes the browser convert a wide-gamut
  // source instead of reinterpreting its numbers.
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (!context) throw new Error("Could not get a 2D context");
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data: data.data, width: data.width, height: data.height };
}

/** HEIC/HEIF for Chrome and Firefox, which have no native decoder. */
async function decodeHeic(request: DecodeRequest): Promise<RgbaImage> {
  const { default: libheif } = await import("libheif-js/wasm-bundle");
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(
    new Uint8Array(await request.blob.arrayBuffer())
  );
  const image = images[0];
  if (!image) throw new UnsupportedImageError("No image in the HEIC container");

  const width = image.get_width();
  const height = image.get_height();
  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    image.display({ data, width, height }, (result: unknown) =>
      result ? resolve() : reject(new Error("HEIC decode failed"))
    );
  });
  return { data, width, height };
}

/**
 * TIFF, for the scanner output. utif2 gives us RGBA directly but knows nothing
 * about ICC profiles, so a wide-gamut scan is treated as sRGB. Scans in scope
 * are sRGB or untagged, and the alternative is not supporting TIFF at all.
 */
async function decodeTiff(request: DecodeRequest): Promise<RgbaImage> {
  const UTIF = await import("utif2");
  const buffer = await request.blob.arrayBuffer();
  const pages = UTIF.decode(buffer);
  const page = pages[0];
  if (!page) throw new UnsupportedImageError("No image in the TIFF");
  UTIF.decodeImage(buffer, page);
  const rgba = UTIF.toRGBA8(page);
  return {
    data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width: page.width,
    height: page.height,
  };
}
