/**
 * Reproduce a Wix delivery in the browser, for the comparison view.
 *
 * Same decision logic as the benchmark (src/lib/wix-emulate.ts); this is the
 * jSquash execution of it. bench/calibrate.ts establishes that the model is
 * faithful to within about 4% on bytes and 0.6 SSIMULACRA2 on damage, for the
 * reductions these presets work at.
 *
 * The point of showing this is that the pair a visitor could actually tell
 * apart is not "original vs optimised" — it is "Wix's render of the original"
 * vs "Wix's render of the optimised file". Those two are the bottom row of the
 * comparison, and they are the ones that have to match.
 */

import { decodeToRgba } from "./decode";
import type { ProbeResult } from "./probe";
import { unsharpMask, type RgbaImage } from "./unsharp";
import {
  WIX_USM,
  wixDelivery,
  wixDeviceBox,
  WIX_MAX_DPR,
  type Size,
  type WixDelivery,
} from "./wix-emulate";

/**
 * Encoder quality that reproduces Wix's `quality_auto` AVIF, fitted against
 * live static.wixstatic.com derivatives. Kept in step with the same constant
 * in bench/wix-render.ts.
 */
export const AVIF_AUTO_QUALITY = 78;

export interface WixPreview {
  delivery: WixDelivery;
  /** Encoded exactly as Wix would send it. */
  blob: Blob;
  /** Bytes on the wire, for the caption. */
  size: number;
  /** The browser's backing store for this element. */
  raster: Size;
}

export interface WixPreviewRequest {
  blob: Blob;
  meta: ProbeResult;
  /** The CSS box the image occupies on the page. */
  css: Size;
  /**
   * AVIF is what most visitors get but is slow to encode in WASM. Passing
   * "webp" keeps the preview responsive at the cost of a slightly different
   * artifact character.
   */
  wire?: "avif" | "webp";
}

export async function renderWixPreview(
  request: WixPreviewRequest
): Promise<WixPreview> {
  const wire = request.wire ?? "avif";
  const delivery = wixDelivery({
    source: request.meta,
    css: request.css,
    accept: wire === "avif" ? "image/avif,image/webp,*/*" : "image/webp,*/*",
  });

  let image = await decodeToRgba({
    blob: request.blob,
    meta: request.meta,
    target: delivery.rendered,
  });

  // Recompute against the decoded size: an EXIF-rotated frame comes back the
  // other way round from what the header said.
  const rendered = wixDelivery({
    source: image,
    css: request.css,
    accept: wire === "avif" ? "image/avif,image/webp,*/*" : "image/webp,*/*",
  });

  if (
    image.width !== rendered.rendered.width ||
    image.height !== rendered.rendered.height
  ) {
    image = await resizeTo(image, rendered.rendered);
  }
  if (rendered.applyUsm) {
    unsharpMask(image, 1, WIX_USM);
  }

  const blob = await encodeAsWix(image, wire, rendered);
  return {
    delivery: rendered,
    blob,
    size: blob.size,
    raster: wixDeviceBox(request.css, WIX_MAX_DPR),
  };
}

async function resizeTo(image: RgbaImage, target: Size): Promise<RgbaImage> {
  const { default: resize } = await import("@jsquash/resize");
  const result = await resize(
    new ImageData(
      image.data as Uint8ClampedArray<ArrayBuffer>,
      image.width,
      image.height
    ),
    {
      width: target.width,
      height: target.height,
      method: "lanczos3",
      fitMethod: "stretch",
      premultiply: true,
      linearRGB: false,
    }
  );
  return { data: result.data, width: result.width, height: result.height };
}

async function encodeAsWix(
  image: RgbaImage,
  wire: "avif" | "webp",
  delivery: WixDelivery
): Promise<Blob> {
  const data = new ImageData(
    image.data as Uint8ClampedArray<ArrayBuffer>,
    image.width,
    image.height
  );
  if (wire === "avif") {
    const { encode } = await import("@jsquash/avif");
    // speed 8 rather than the 4 the benchmark uses: this is a preview a person
    // is waiting on, and the size difference does not change what they see.
    const buffer = await encode(data, {
      quality: AVIF_AUTO_QUALITY,
      subsample: 3,
      speed: 8,
    });
    return new Blob([buffer], { type: "image/avif" });
  }
  const { encode } = await import("@jsquash/webp");
  const buffer = await encode(data, {
    quality: delivery.quality,
    method: 4,
    use_sharp_yuv: 1,
  });
  return new Blob([buffer], { type: "image/webp" });
}
