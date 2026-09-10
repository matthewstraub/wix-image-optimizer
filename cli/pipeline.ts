/**
 * The sharp implementation of the optimisation pipeline.
 *
 * Used by the CLI and the benchmark. The browser ships an equivalent built on
 * jSquash; tests/parity.test.ts checks the two stay perceptually together.
 */

import sharp, { type Sharp } from "sharp";
import {
  EXTENSION_FOR_FORMAT,
  targetDimensions,
  type EncodeSettings,
} from "../src/lib/presets.ts";
import { DEFAULT_SHARPEN, toLibvipsSharpen } from "../src/lib/unsharp.ts";

export interface ProcessResult {
  data: Buffer;
  width: number;
  height: number;
  format: EncodeSettings["format"];
  ext: string;
  sourceWidth: number;
  sourceHeight: number;
  /** True when the source had transparency and was kept as PNG. */
  keptAlpha: boolean;
}

export function openSource(input: string | Buffer): Sharp {
  return sharp(input, {
    // A truncated or slightly malformed JPEG should still produce a usable
    // image rather than failing the whole batch.
    failOn: "none",
    // The largest file in scope is a 453 MP scan; sharp's default ceiling is
    // 268 MP and would reject it outright.
    limitInputPixels: false,
    // Keeps peak memory bounded on very large sources.
    sequentialRead: true,
  });
}

export async function processImage(
  input: string | Buffer,
  settings: EncodeSettings
): Promise<ProcessResult> {
  const probe = openSource(input);
  const meta = await probe.metadata();

  // autoOrient happens before this, so a portrait frame tagged sideways
  // reports its landscape dimensions here. Swap to match what we will emit.
  const swap = (meta.orientation ?? 1) >= 5;
  const sourceWidth = (swap ? meta.height : meta.width) ?? 0;
  const sourceHeight = (swap ? meta.width : meta.height) ?? 0;
  if (!sourceWidth || !sourceHeight) {
    throw new Error("Could not read image dimensions");
  }

  const keptAlpha = Boolean(meta.hasAlpha) && settings.format === "jpeg";
  const format = keptAlpha ? "png" : settings.format;
  const target = targetDimensions(
    { width: sourceWidth, height: sourceHeight },
    settings.maxLongEdge
  );

  let img = openSource(input)
    // Consume the EXIF Orientation tag first; everything downstream then works
    // in display orientation, and stripping metadata cannot rotate the result.
    .autoOrient()
    // 16-bit intermediate. Costs roughly 1.3x and removes banding in the sky
    // gradients that show up on evening reception shots.
    .pipelineColourspace("rgb16")
    .resize({
      width: target.width,
      height: target.height,
      // "fill" rather than "inside" so the output is exactly what
      // targetDimensions computed. "inside" lets sharp re-derive the box and
      // land a pixel away from what the browser pipeline produces for the
      // same input, which then makes the two incomparable. The dimensions
      // already preserve aspect ratio to within that same rounding, and
      // targetDimensions never enlarges, so nothing is stretched or upscaled.
      fit: "fill",
      kernel: "lanczos3",
      // Shrink-on-load is faster but introduces artifacts we would then
      // sharpen; this pipeline is quality-critical.
      fastShrinkOnLoad: false,
    });

  const downscaled = target.width < sourceWidth;
  if (settings.sharpen > 0 && downscaled) {
    img = img.sharpen(toLibvipsSharpen(DEFAULT_SHARPEN, settings.sharpen));
  }

  // No metadata calls: sharp's default is already to convert to sRGB and drop
  // EXIF, ICC, XMP and IPTC, which is exactly what we want.
  img = encodeWith(img, format, settings);

  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    format,
    ext: EXTENSION_FOR_FORMAT[format],
    sourceWidth,
    sourceHeight,
    keptAlpha,
  };
}

function encodeWith(
  img: Sharp,
  format: EncodeSettings["format"],
  settings: EncodeSettings
): Sharp {
  switch (format) {
    case "jpeg":
      return img.jpeg({
        quality: settings.quality,
        // Implies trellis quantisation, overshoot deringing, optimised scans
        // and quantisation table 3 — and forces progressive along the way.
        mozjpeg: true,
        chromaSubsampling: settings.chroma,
      });
    case "webp":
      // Lossy WebP is always 4:2:0; smartSubsample is the only mitigation and
      // costs about 2.5% at low quality, nothing at high.
      return img.webp({ quality: settings.quality, effort: 6, smartSubsample: true });
    case "avif":
      return img.avif({
        quality: settings.quality,
        effort: 5,
        chromaSubsampling: "4:4:4",
      });
    case "png":
      return img.png({ compressionLevel: 9, palette: false });
  }
}
