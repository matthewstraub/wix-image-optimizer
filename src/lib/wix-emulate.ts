/**
 * A model of what Wix actually delivers to a browser.
 *
 * This is the reference the whole project is measured against. Comparing our
 * output to the original photo would answer the wrong question, because
 * nobody ever sees the original — Wix re-encodes on every `/v1/` transform URL,
 * including at the source's own native resolution. The only comparison that
 * matters is Wix's delivery of our upload against Wix's delivery of the
 * original.
 *
 * Every constant below is read from Wix's published `@wix/image-kit` bundle or
 * confirmed against `static.wixstatic.com` by direct request. See RESEARCH.md.
 *
 * This module holds decision logic only, so the benchmark (sharp) and the
 * comparison view (jSquash) can share it and be checked against each other.
 */

import type { SharpenOptions } from "./unsharp";

/** `MAX_DEVICE_PIXEL_RATIO` in imageServiceConstants.js. 3x phones get 2x. */
export const WIX_MAX_DPR = 2;

/** `MAX_TRANSFORMED_IMAGE_WIDTH` / `..._HEIGHT`. */
export const WIX_MAX_TRANSFORM_EDGE = 5000;

/** `SAFE_TRANSFORMED_AREA`. Targets above this are scaled back by sqrt. */
export const WIX_SAFE_AREA = 25_000_000;

/** Wix honours an explicit `q_` only inside this range. */
export const WIX_QUALITY_MIN = 5;
export const WIX_QUALITY_MAX = 90;

/**
 * `imageScaleDefaults`, keyed by rendered area. Quality is chosen from how big
 * the image lands on the page, not from anything about the source.
 */
const QUALITY_TIERS = [
  { minArea: 1400 * 1400, quality: 90 },
  { minArea: 600 * 600, quality: 85 },
  { minArea: 400 * 400, quality: 80 },
  { minArea: 0, quality: 80 },
] as const;

/**
 * `defaultUSM` in imageServiceConstants.js: radius 0.66, amount 1.00,
 * threshold 0.01. That is a classic unsharp mask rather than libvips' curve,
 * so it maps onto our transfer function as a hard-ish threshold at
 * 0.01 * 255 with a single slope above it.
 */
export const WIX_USM: SharpenOptions = {
  sigma: 0.66,
  x1: 0.01 * 255,
  y2: 255,
  y3: 255,
  m1: 0,
  m2: 1.0,
};

export interface Size {
  width: number;
  height: number;
}

/**
 * Quality Wix will encode at for an image rendered at this area.
 * PNG output gets +5 on top of the tier value.
 */
export function wixQualityForArea(area: number, png = false): number {
  const tier = QUALITY_TIERS.find(t => area >= t.minArea) ?? QUALITY_TIERS[3];
  return tier.quality + (png ? 5 : 0);
}

/** What Wix does with an explicit `q_`: honour it, or fall back to the tier. */
export function wixEffectiveQuality(
  requested: number | undefined,
  area: number,
  png = false
): number {
  if (
    requested !== undefined &&
    requested >= WIX_QUALITY_MIN &&
    requested <= WIX_QUALITY_MAX
  ) {
    return requested;
  }
  return wixQualityForArea(area, png);
}

/** The device-pixel box Wix will request for a CSS box, given their DPR cap. */
export function wixDeviceBox(css: Size, dpr: number): Size {
  const k = Math.min(dpr, WIX_MAX_DPR);
  return {
    width: Math.round(css.width * k),
    height: Math.round(css.height * k),
  };
}

/**
 * Wix floors, but a scale derived by division can land a hair under an exact
 * integer (400/1824*1824 is 400.00000000000006 one way and 399.99999999 the
 * other). Absorb that before flooring so the result is not a pixel short for
 * reasons of binary arithmetic rather than of Wix's behaviour.
 */
const floorish = (x: number) => Math.max(1, Math.floor(x + 1e-9));

/**
 * The size Wix's `fit` transform produces: scale into the requested box
 * preserving aspect ratio, never upscale, then pull back inside the 5000px /
 * 25MP transform ceiling.
 *
 * Wix floors the derived edge rather than rounding it. Measured against live
 * derivatives of a 1824x1270 asset, where the two disagree:
 *
 *   w_400  -> 400x278  (exact 278.509, round would give 279)
 *   w_900  -> 900x626  (exact 626.645, round would give 627)
 *   w_1100 -> 1100x765 (exact 765.899, round would give 766)
 *
 * Being one pixel out is not cosmetic here: the metrics compare arrays and
 * refuse to score mismatched shapes.
 */
export function wixFit(source: Size, box: Size): Size {
  // Both dimensions bind. The URL Wix emits carries w_ and h_ together, so a
  // portrait photo in a wide hero is limited by height, not width — modelling
  // only the width turns a 3578x5377 frame into a 22 megapixel render that
  // nothing would ever ask for.
  const scale = Math.min(
    box.width / source.width,
    box.height / source.height,
    1
  );
  let w = floorish(source.width * scale);
  let h = floorish(source.height * scale);

  const edge = Math.max(w, h);
  if (edge > WIX_MAX_TRANSFORM_EDGE) {
    const k = WIX_MAX_TRANSFORM_EDGE / edge;
    w = floorish(w * k);
    h = floorish(h * k);
  }
  if (w * h > WIX_SAFE_AREA) {
    const k = Math.sqrt(WIX_SAFE_AREA / (w * h));
    w = floorish(w * k);
    h = floorish(h * k);
  }
  return { width: w, height: h };
}

export type WixTransformType = "fit" | "fill" | "crop";

/**
 * `isUSMNeeded`, transcribed from imageTransformOptions.js:
 *
 *   const upscale = transformPart.scaleFactor >= 1;
 *   return !upscale || transformPart.forceUSM ||
 *          transformPart.transformType === transformTypes.FIT;
 *
 * The `fit` clause is the surprising one and it is not an edge case: `fit` is
 * what the editor emits, so Wix sharpens even when it is handing back the
 * source at its own native size. Calibration against live derivatives only
 * lined up once this was modelled.
 */
export function wixAppliesUsm(
  source: Size,
  rendered: Size,
  transform: WixTransformType = "fit"
): boolean {
  if (transform === "fit") return true;
  return rendered.width < source.width || rendered.height < source.height;
}

export type WixWireFormat = "avif" | "webp" | "jpeg";

/**
 * What `enc_auto` negotiates from an Accept header. Confirmed by probe:
 * AVIF-capable clients get AVIF, WebP-capable get WebP, everyone else JPEG.
 */
export function wixWireFormat(accept: string): WixWireFormat {
  if (accept.includes("image/avif")) return "avif";
  if (accept.includes("image/webp")) return "webp";
  return "jpeg";
}

export interface WixDelivery {
  rendered: Size;
  format: WixWireFormat;
  /** Encoder quality on Wix's own scale. */
  quality: number;
  applyUsm: boolean;
  /**
   * True when `quality_auto` is in play, which Wix always emits alongside
   * AVIF. In that case any requested `q_` is discarded and their own
   * perceptual algorithm picks — measured as landing near their q75.
   */
  qualityAuto: boolean;
}

export interface WixDeliveryRequest {
  source: Size;
  /** The CSS box the image occupies on the page. */
  css: Size;
  dpr?: number;
  accept?: string;
  /** An explicit `q_`, which AVIF's `quality_auto` will override anyway. */
  requestedQuality?: number;
  png?: boolean;
  /** Editor-generated URLs use `fit` for content and `fill` for crops. */
  transform?: WixTransformType;
}

/**
 * Wix's own auto-quality, in their AVIF quality units. Measured: `enc_auto`
 * produced byte-identical output to an explicit `q_75` across several
 * qualities, so their algorithm lands there for a typical photo.
 *
 * The encoder-specific value used to reproduce this locally is calibrated
 * separately, in bench/calibrate.ts, against real wixstatic derivatives.
 */
export const WIX_AUTO_QUALITY = 75;

/** Resolve a page context into everything needed to reproduce the delivery. */
export function wixDelivery(req: WixDeliveryRequest): WixDelivery {
  const dpr = req.dpr ?? WIX_MAX_DPR;
  const requested = wixDeviceBox(req.css, dpr);
  const rendered = wixFit(req.source, requested);
  const format = wixWireFormat(req.accept ?? "image/avif,image/webp,*/*");
  const area = rendered.width * rendered.height;
  const qualityAuto = format === "avif";

  return {
    rendered,
    format,
    quality: qualityAuto
      ? WIX_AUTO_QUALITY
      : wixEffectiveQuality(req.requestedQuality, area, req.png),
    applyUsm: wixAppliesUsm(req.source, rendered, req.transform ?? "fit"),
    qualityAuto,
  };
}

/**
 * The page contexts we evaluate against — a full-bleed hero, an in-content
 * blog image, and a gallery thumbnail, all at Wix's 2x DPR ceiling.
 */
export const RENDER_CONTEXTS = [
  { id: "hero", label: "Full-bleed hero", css: { width: 1920, height: 1080 } },
  {
    id: "content",
    label: "Blog / in-content",
    css: { width: 960, height: 720 },
  },
  { id: "thumb", label: "Gallery thumbnail", css: { width: 400, height: 400 } },
] as const;

export type RenderContextId = (typeof RENDER_CONTEXTS)[number]["id"];
