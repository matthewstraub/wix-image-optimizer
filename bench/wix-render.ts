/**
 * Reproduce a Wix delivery locally, with sharp.
 *
 * The decision logic lives in src/lib/wix-emulate.ts and is shared with the
 * browser. This is only the execution: resize, their unsharp mask, their
 * encoder settings.
 */

import sharp, { type Sharp } from "sharp";
import {
  WIX_USM,
  wixDelivery,
  type Size,
  type WixDelivery,
} from "../src/lib/wix-emulate.ts";
import { toLibvipsSharpen } from "../src/lib/unsharp.ts";
import { openSource } from "../cli/pipeline.ts";

/**
 * Encoder quality that reproduces Wix's `quality_auto` AVIF output.
 *
 * Wix's own quality number is not our encoder's quality number, so this is
 * fitted against real static.wixstatic.com derivatives by bench/calibrate.ts
 * rather than assumed.
 */
export let AVIF_AUTO_QUALITY = 78;

export function setAvifAutoQuality(q: number): void {
  AVIF_AUTO_QUALITY = q;
}

export interface RenderedDelivery {
  delivery: WixDelivery;
  bytes: Buffer;
  /** Decoded to PNG so the metrics have a lossless common format. */
  png: Buffer;
}

export interface RenderOptions {
  /** The CSS box the image occupies on the page. */
  css: Size;
  dpr?: number;
  accept?: string;
  /** Override the fitted AVIF quality, for the calibration sweep itself. */
  avifQuality?: number;
}

/** Run one image through Wix's pipeline as a browser would receive it. */
export async function renderAsWix(
  input: Buffer,
  source: Size,
  options: RenderOptions
): Promise<RenderedDelivery> {
  const delivery = wixDelivery({
    source,
    css: options.css,
    ...(options.dpr !== undefined ? { dpr: options.dpr } : {}),
    ...(options.accept !== undefined ? { accept: options.accept } : {}),
  });

  let img = openSource(input).autoOrient().pipelineColourspace("rgb16").resize({
    width: delivery.rendered.width,
    height: delivery.rendered.height,
    // "fill" rather than "inside" so the output is exactly the size wixFit
    // computed. The dimensions already preserve aspect ratio up to Wix's own
    // flooring, and letting sharp re-derive them reintroduces the one-pixel
    // disagreement that stops the metrics from scoring at all.
    fit: "fill",
    kernel: "lanczos3",
    fastShrinkOnLoad: false,
  });

  if (delivery.applyUsm) {
    img = img.sharpen(toLibvipsSharpen(WIX_USM, 1));
  }

  const bytes = await encodeAsWix(
    img,
    delivery,
    options.avifQuality ?? AVIF_AUTO_QUALITY
  );
  const png = await sharp(bytes).png({ compressionLevel: 1 }).toBuffer();
  return { delivery, bytes, png };
}

function encodeAsWix(
  img: Sharp,
  delivery: WixDelivery,
  avifQuality: number
): Promise<Buffer> {
  switch (delivery.format) {
    case "avif":
      return img
        .avif({ quality: avifQuality, effort: 4, chromaSubsampling: "4:4:4" })
        .toBuffer();
    case "webp":
      return img
        .webp({ quality: delivery.quality, effort: 4, smartSubsample: true })
        .toBuffer();
    case "jpeg":
      return img
        .jpeg({ quality: delivery.quality, chromaSubsampling: "4:2:0" })
        .toBuffer();
  }
}

/**
 * The browser's own final scale onto the device raster, which is the step that
 * makes the whole comparison fair.
 *
 * At a full-bleed hero on a 2x display the backing store is 3840px wide
 * whatever Wix sent. A 6048px original comes back from Wix at 3840 and lands
 * 1:1; a 2560px upload comes back at 2560 — Wix never upscales — and the
 * browser stretches it to 3840. Skipping this step would compare a 3840px
 * image against a 2560px one, which is not what anybody sees and is not
 * scoreable anyway.
 *
 * Upscaling uses Catmull-Rom rather than lanczos3 deliberately: browsers do
 * not use a sharp resampling kernel here, and giving our candidate a better
 * upscale than it will really get would flatter it.
 */
export async function toDisplayRaster(
  bytes: Buffer,
  target: Size
): Promise<Buffer> {
  return sharp(bytes)
    .resize({
      width: target.width,
      height: target.height,
      fit: "fill",
      kernel: "cubic",
    })
    .png({ compressionLevel: 1 })
    .toBuffer();
}
