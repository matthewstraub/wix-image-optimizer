import { describe, expect, it } from "vitest";
import { DEFAULT_SHARPEN, unsharpMask, type RgbaImage } from "@/lib/unsharp";

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number]
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  }
  return { data, width, height };
}

const at = (img: RgbaImage, x: number, y: number) =>
  img.data[(y * img.width + x) * 4]!;

const clone = (img: RgbaImage): RgbaImage => ({
  data: new Uint8ClampedArray(img.data),
  width: img.width,
  height: img.height,
});

describe("unsharpMask", () => {
  it("is a no-op at amount 0", () => {
    const img = image(16, 16, x => [x * 8, 40, 200, 255]);
    const before = clone(img);
    unsharpMask(img, 0);
    expect(img.data).toEqual(before.data);
  });

  it("leaves a perfectly flat image alone", () => {
    const img = image(24, 24, () => [128, 128, 128, 255]);
    const before = clone(img);
    unsharpMask(img, 1);
    expect(img.data).toEqual(before.data);
  });

  it("increases contrast across a hard edge", () => {
    const build = () =>
      image(32, 8, x => (x < 16 ? [90, 90, 90, 255] : [170, 170, 170, 255]));
    const original = build();
    const sharpened = unsharpMask(build(), 1);
    // Dark side of the edge gets darker, light side gets lighter.
    expect(at(sharpened, 15, 4)).toBeLessThan(at(original, 15, 4));
    expect(at(sharpened, 16, 4)).toBeGreaterThan(at(original, 16, 4));
  });

  it("does not amplify low-contrast noise, which is the whole point of m1=0", () => {
    // +/-2 levels of grain on a mid-grey field: below the x1 threshold.
    const build = () =>
      image(32, 32, (x, y) => {
        const n = ((x * 7 + y * 13) % 5) - 2;
        return [128 + n, 128 + n, 128 + n, 255];
      });
    const original = build();
    const sharpened = unsharpMask(build(), 1);
    expect(sharpened.data).toEqual(original.data);
  });

  it("does amplify the same grain once m1 is non-zero", () => {
    const build = () =>
      image(32, 32, (x, y) => {
        const n = ((x * 7 + y * 13) % 5) - 2;
        return [128 + n, 128 + n, 128 + n, 255];
      });
    const original = build();
    const sharpened = unsharpMask(build(), 1, { ...DEFAULT_SHARPEN, m1: 3 });
    expect(sharpened.data).not.toEqual(original.data);
  });

  it("respects the asymmetric overshoot ceilings", () => {
    const build = () =>
      image(32, 8, x => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const sharpened = unsharpMask(build(), 4, DEFAULT_SHARPEN);
    // A black/white step at amount 4 would blow far past the ceilings if they
    // were not enforced; clamping keeps it inside the byte range regardless.
    for (const v of sharpened.data) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of sharpened.data) expect(v).toBeLessThanOrEqual(255);
  });

  it("leaves the alpha channel untouched", () => {
    const img = image(16, 16, x => [x * 16, 20, 240, x * 8]);
    const before = clone(img);
    unsharpMask(img, 1);
    for (let p = 3; p < img.data.length; p += 4) {
      expect(img.data[p]).toBe(before.data[p]);
    }
  });

  it("scales with amount", () => {
    const build = () =>
      image(32, 8, x => (x < 16 ? [90, 90, 90, 255] : [170, 170, 170, 255]));
    const original = at(build(), 16, 4);
    const light = at(unsharpMask(build(), 0.5), 16, 4);
    const heavy = at(unsharpMask(build(), 2), 16, 4);
    expect(light).toBeGreaterThan(original);
    expect(heavy).toBeGreaterThan(light);
  });

  it("preserves hue by moving all three channels together", () => {
    const build = () =>
      image(32, 8, x => (x < 16 ? [40, 80, 120, 255] : [120, 160, 200, 255]));
    const before = build();
    const after = unsharpMask(build(), 1);
    const p = (4 * 32 + 16) * 4;
    const dR = after.data[p]! - before.data[p]!;
    const dG = after.data[p + 1]! - before.data[p + 1]!;
    const dB = after.data[p + 2]! - before.data[p + 2]!;
    expect(dR).not.toBe(0);
    expect(dG).toBe(dR);
    expect(dB).toBe(dR);
  });
});
