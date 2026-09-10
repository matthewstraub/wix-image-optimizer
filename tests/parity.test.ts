import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { processImage } from "../cli/pipeline.ts";
import { processRgba } from "@/lib/pipeline";
import { getPreset, type EncodeSettings } from "@/lib/presets";
import { initJsquashForNode } from "./helpers/jsquash-node.ts";

/**
 * The web app encodes with jSquash and the CLI encodes with sharp. Both wrap
 * MozJPEG and libvips' Lanczos3, but they expose slightly different knobs, so
 * the outputs are not byte-identical and cannot be.
 *
 * What must hold is that they are interchangeable in practice: the benchmark
 * measured the sharp pipeline, and the browser is what actually ships. If
 * these drift the preset numbers stop meaning anything.
 */

const FIXTURES = "bench/fixtures/sample";

beforeAll(initJsquashForNode);

async function fixtures(limit: number): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.jpe?g$/i.test(entry.name)) out.push(full);
    }
  }
  await visit(FIXTURES);
  return out.sort().slice(0, limit);
}

/** Decode with sharp so both pipelines start from identical pixels. */
async function decodeWithSharp(path: string) {
  const { data, info } = await sharp(path)
    .autoOrient()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Mean absolute per-channel difference, 0-255. */
async function meanAbsDiff(a: Uint8Array, b: Uint8Array): Promise<number> {
  const raw = (bytes: Uint8Array) =>
    sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [left, right] = await Promise.all([raw(a), raw(b)]);
  expect(left.info.width).toBe(right.info.width);
  expect(left.info.height).toBe(right.info.height);
  let total = 0;
  for (let i = 0; i < left.data.length; i++) {
    total += Math.abs(left.data[i]! - right.data[i]!);
  }
  return total / left.data.length;
}

describe("browser and CLI pipelines agree", () => {
  const settings: EncodeSettings = getPreset("standard").settings;
  let paths: string[] = [];

  beforeAll(async () => {
    paths = await fixtures(3);
    expect(paths.length).toBeGreaterThan(0);
  });

  it("produce the same output dimensions", async () => {
    for (const path of paths) {
      const viaSharp = await processImage(path, settings);
      const viaBrowser = await processRgba(
        await decodeWithSharp(path),
        settings,
        {
          canHaveAlpha: false,
        }
      );
      expect(viaBrowser.width).toBe(viaSharp.width);
      expect(viaBrowser.height).toBe(viaSharp.height);
      expect(Math.max(viaBrowser.width, viaBrowser.height)).toBe(
        settings.maxLongEdge
      );
    }
  }, 180_000);

  it("land within 25% of each other on file size", async () => {
    for (const path of paths) {
      const viaSharp = await processImage(path, settings);
      const viaBrowser = await processRgba(
        await decodeWithSharp(path),
        settings,
        {
          canHaveAlpha: false,
        }
      );
      const ratio = viaBrowser.bytes.byteLength / viaSharp.data.byteLength;
      expect(ratio).toBeGreaterThan(0.75);
      expect(ratio).toBeLessThan(1.25);
    }
  }, 180_000);

  it("differ by only a couple of levels per channel", async () => {
    for (const path of paths) {
      const viaSharp = await processImage(path, settings);
      const viaBrowser = await processRgba(
        await decodeWithSharp(path),
        settings,
        { canHaveAlpha: false }
      );
      // Measured on these fixtures: 2.5-3.3 mean levels out of 255, about
      // 1.2%, with output sizes within 5%. Decomposing it, the unsharp masks
      // contribute only ~0.15 of that (the same run with sharpen 0 gives
      // 2.5-3.2), so almost all of it is the two Lanczos3 implementations and
      // the two encoders' quantisation choices — irreducible, and invisible.
      //
      // The bound is there to catch a real divergence: a wrong resampling
      // kernel, a skipped stage, or mishandled colour all land well into
      // double figures.
      const diff = await meanAbsDiff(viaBrowser.bytes, viaSharp.data);
      expect(diff).toBeLessThan(4);
    }
  }, 180_000);

  it("both emit progressive 4:4:4 sRGB JPEG with no metadata", async () => {
    const path = paths[0]!;
    const viaBrowser = await processRgba(
      await decodeWithSharp(path),
      settings,
      {
        canHaveAlpha: false,
      }
    );
    const meta = await sharp(viaBrowser.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.space).toBe("srgb");
    expect(meta.chromaSubsampling).toBe("4:4:4");
    expect(meta.isProgressive).toBe(true);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  }, 180_000);
});
