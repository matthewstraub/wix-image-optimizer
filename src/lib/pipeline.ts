/**
 * The browser optimisation pipeline.
 *
 * decode -> resize (Lanczos3) -> unsharp -> encode, with the colour and
 * orientation work handled in decode.ts.
 *
 * cli/pipeline.ts is the sharp equivalent, used by the CLI and the benchmark.
 * The two do not produce byte-identical output — jSquash exposes a slightly
 * different set of MozJPEG knobs than libvips does — so tests/parity.test.ts
 * checks they stay together on both size and measured quality.
 */

import { decodeToRgba } from "./decode";
import type { ProbeResult } from "./probe";
import { unsharpMask, type RgbaImage } from "./unsharp";
import {
  EXTENSION_FOR_FORMAT,
  targetDimensions,
  type EncodeSettings,
  type OutputFormat,
} from "./presets";

export interface OptimiseResult {
  bytes: Uint8Array;
  format: OutputFormat;
  ext: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** True when the source had transparency and was kept lossless as PNG. */
  keptAlpha: boolean;
}

export async function optimise(
  blob: Blob,
  meta: ProbeResult,
  settings: EncodeSettings
): Promise<OptimiseResult> {
  // The decoder is told the eventual target so it can stage a large source
  // down as it goes. Computed from header dimensions, which is fine: it only
  // needs to be about right.
  const provisional = targetDimensions(meta, settings.maxLongEdge);
  const image = await decodeToRgba({ blob, meta, target: provisional });
  return processRgba(image, settings, { canHaveAlpha: meta.kind !== "jpeg" });
}

/**
 * Everything after decoding: resize, sharpen, encode.
 *
 * Separated out so it can run in Node against pixels produced by sharp, which
 * is how tests/parity.test.ts checks the browser and CLI pipelines have not
 * drifted apart. `optimise` is the browser entry point.
 */
export async function processRgba(
  source: RgbaImage,
  settings: EncodeSettings,
  options: { canHaveAlpha?: boolean } = {}
): Promise<OptimiseResult> {
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const target = targetDimensions(source, settings.maxLongEdge);

  const hasAlpha = (options.canHaveAlpha ?? true) && detectAlpha(source);
  const format: OutputFormat =
    hasAlpha && settings.format === "jpeg" ? "png" : settings.format;

  let image = source;
  if (image.width !== target.width || image.height !== target.height) {
    image = await resizeTo(image, target);
  }

  // Only recover micro-contrast we actually threw away. Sharpening an image
  // that was already at or below the target just adds halos.
  if (settings.sharpen > 0 && target.width < sourceWidth) {
    unsharpMask(image, settings.sharpen);
  }

  const bytes = await encode(image, format, settings);
  return {
    bytes,
    format,
    ext: EXTENSION_FOR_FORMAT[format],
    width: image.width,
    height: image.height,
    sourceWidth,
    sourceHeight,
    keptAlpha: hasAlpha && settings.format === "jpeg",
  };
}

/**
 * Any pixel that is not fully opaque means we cannot flatten to JPEG without
 * silently compositing onto white. Sampling would be faster but risks missing
 * a small transparent logo corner, so this is exhaustive; it is a single pass
 * over one channel.
 */
function detectAlpha(image: RgbaImage): boolean {
  const { data } = image;
  for (let p = 3; p < data.length; p += 4) {
    if (data[p] !== 255) return true;
  }
  return false;
}

async function resizeTo(
  image: RgbaImage,
  target: { width: number; height: number }
): Promise<RgbaImage> {
  const { default: resize } = await import("@jsquash/resize");
  const result = await resize(toImageData(image), {
    width: target.width,
    height: target.height,
    method: "lanczos3",
    fitMethod: "stretch",
    // Premultiply so a transparent edge does not drag its unseen colour into
    // neighbouring pixels.
    premultiply: true,
    // sRGB, not linear light, to match what the sharp pipeline does.
    linearRGB: false,
  });
  return { data: result.data, width: result.width, height: result.height };
}

function toImageData(image: RgbaImage): ImageData {
  // The cast covers the SharedArrayBuffer case in the DOM types, which cannot
  // arise here: every producer in decode.ts allocates a plain ArrayBuffer.
  return new ImageData(
    image.data as Uint8ClampedArray<ArrayBuffer>,
    image.width,
    image.height
  );
}

async function encode(
  image: RgbaImage,
  format: OutputFormat,
  settings: EncodeSettings
): Promise<Uint8Array> {
  const data = toImageData(image);
  switch (format) {
    case "jpeg": {
      const { encode: encodeJpeg } = await import("@jsquash/jpeg");
      const buffer = await encodeJpeg(data, {
        quality: settings.quality,
        baseline: false,
        arithmetic: false,
        progressive: true,
        optimize_coding: true,
        smoothing: 0,
        color_space: 3, // YCbCr
        // Table 3 is the one sharp's `mozjpeg: true` selects.
        quant_table: 3,
        trellis_multipass: true,
        trellis_opt_zero: true,
        trellis_opt_table: true,
        trellis_loops: 1,
        // 4:4:4 keeps full chroma resolution, which matters here specifically
        // because Wix re-encodes: colour detail dropped now cannot come back.
        auto_subsample: false,
        chroma_subsample: settings.chroma === "4:4:4" ? 1 : 2,
        separate_chroma_quality: false,
        chroma_quality: settings.quality,
      });
      return new Uint8Array(buffer);
    }
    case "webp": {
      const { encode: encodeWebp } = await import("@jsquash/webp");
      // Lossy WebP is always 4:2:0; sharp_yuv is the only mitigation and is
      // close to free at these qualities.
      const buffer = await encodeWebp(data, {
        quality: settings.quality,
        method: 6,
        use_sharp_yuv: 1,
      });
      return new Uint8Array(buffer);
    }
    case "avif": {
      const { encode: encodeAvif } = await import("@jsquash/avif");
      const buffer = await encodeAvif(data, {
        quality: settings.quality,
        subsample: 3, // 4:4:4
        // 6 is the practical knee: effort past this costs seconds per image
        // for a change in size that is sometimes negative.
        speed: 6,
      });
      return new Uint8Array(buffer);
    }
    case "png": {
      const { encode: encodePng } = await import("@jsquash/png");
      const { optimise: optimisePng } = await import("@jsquash/oxipng");
      const raw = await encodePng(data);
      // Lossless. A transparent source is usually a logo or an export, where
      // throwing away colour data is not an acceptable trade.
      const optimised = await optimisePng(raw, { level: 3, interlace: false });
      return new Uint8Array(optimised);
    }
  }
}
