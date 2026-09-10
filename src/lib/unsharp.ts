/**
 * Unsharp mask, shaped after libvips' `sharpen`.
 *
 * Downscaling a 6000px frame to 2560px throws away micro-contrast, and a flat
 * Lanczos result looks soft next to the original. The naive fix — a plain
 * unsharp mask — also amplifies sensor noise in skies and adds halos to skin,
 * which on high-ISO reception photos looks far worse than the softness did.
 *
 * libvips solves this with a piecewise transfer curve: differences smaller
 * than `x1` are treated as flat detail and scaled by `m1`, everything above is
 * treated as an edge and scaled by `m2`. With `m1: 0` flat areas are left
 * exactly alone, so grain and sky gradients pass through untouched while
 * genuine edges still get crisped.
 *
 * Deviation from libvips worth knowing about: libvips runs this on L* in LAB.
 * Converting 4.4M pixels to LAB and back costs more than it buys here, so this
 * works on Rec.709 luma of the gamma-encoded values and adds the resulting
 * delta equally to R, G and B, which leaves hue and saturation alone.
 */

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface SharpenOptions {
  /** Gaussian radius. libvips suggests ~0.5 at display resolution. */
  sigma: number;
  /** Flat/edge threshold, in 8-bit luma units. */
  x1: number;
  /** Ceiling on brightening, in 8-bit luma units. */
  y2: number;
  /** Ceiling on darkening, in 8-bit luma units. */
  y3: number;
  /** Slope applied below x1. Zero means flat areas are untouched. */
  m1: number;
  /** Slope applied above x1. The knob to turn for more or less bite. */
  m2: number;
}

/**
 * libvips' defaults are given in L* units (0-100); these are the same shape
 * scaled to 8-bit (x2.55), with sigma raised slightly because our downscales
 * are larger than the display-resolution case libvips is describing.
 */
export const DEFAULT_SHARPEN: SharpenOptions = {
  sigma: 0.6,
  x1: 5,
  y2: 25,
  y3: 51,
  m1: 0,
  m2: 2.5,
};

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  const denom = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    const v = Math.exp(-(x * x) / denom);
    kernel[i] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) kernel[i]! /= sum;
  return kernel;
}

/** Separable Gaussian with edge replication. */
function blur(
  src: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array
): Float32Array {
  const radius = (kernel.length - 1) / 2;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        acc += src[row + sx]! * kernel[k + radius]!;
      }
      tmp[row + x] = acc;
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += tmp[sy * width + x]! * kernel[k + radius]!;
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

/**
 * Sharpen in place and return the same image.
 *
 * `amount` scales both slopes; 0 is a no-op and 1 is the calibrated default.
 */
export function unsharpMask(
  image: RgbaImage,
  amount = 1,
  options: SharpenOptions = DEFAULT_SHARPEN
): RgbaImage {
  if (amount <= 0) return image;

  const { data, width, height } = image;
  const count = width * height;
  const luma = new Float32Array(count);
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    luma[i] = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
  }

  const blurred = blur(luma, width, height, gaussianKernel(options.sigma));
  const { x1, y2, y3, m1, m2 } = options;
  const flatSlope = m1 * amount;
  const edgeSlope = m2 * amount;
  // Value the curve has reached at the flat/edge break, so the two segments
  // join up instead of stepping.
  const kneeAt = x1 * flatSlope;

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const diff = luma[i]! - blurred[i]!;
    const magnitude = Math.abs(diff);

    let delta =
      magnitude < x1
        ? diff * flatSlope
        : Math.sign(diff) * (kneeAt + (magnitude - x1) * edgeSlope);

    // Asymmetric ceilings: overshoot into the highlights reads as a halo far
    // sooner than an equivalent dip into the shadows does.
    if (delta > y2) delta = y2;
    else if (delta < -y3) delta = -y3;

    if (delta === 0) continue;
    data[p] = data[p]! + delta;
    data[p + 1] = data[p + 1]! + delta;
    data[p + 2] = data[p + 2]! + delta;
  }

  return image;
}

/**
 * The same curve expressed in libvips' own units, for `sharp.sharpen()`.
 * libvips works on L* (0-100) where we work on 8-bit luma, so the thresholds
 * scale by 100/255 while the slopes, being ratios, do not.
 *
 * Keeping this as a derivation rather than a second set of constants is
 * deliberate: the browser and CLI pipelines must not drift apart.
 */
export function toLibvipsSharpen(
  options: SharpenOptions = DEFAULT_SHARPEN,
  amount = 1
): {
  sigma: number;
  x1: number;
  y2: number;
  y3: number;
  m1: number;
  m2: number;
} {
  const k = 100 / 255;
  return {
    sigma: options.sigma,
    x1: options.x1 * k,
    y2: options.y2 * k,
    y3: options.y3 * k,
    m1: options.m1 * amount,
    m2: options.m2 * amount,
  };
}
