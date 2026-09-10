import { describe, expect, it } from "vitest";
import {
  clampSettings,
  DEFAULT_PRESET_ID,
  getPreset,
  PRESETS,
  targetDimensions,
  WIX_MAX_LONG_EDGE,
} from "@/lib/presets";

describe("targetDimensions", () => {
  it("fits a landscape DSLR frame to the long edge", () => {
    expect(targetDimensions({ width: 7769, height: 5827 }, 2560)).toEqual({
      width: 2560,
      height: 1920,
    });
  });

  it("uses height as the long edge for a portrait frame", () => {
    expect(targetDimensions({ width: 5435, height: 8152 }, 2560)).toEqual({
      width: 1707,
      height: 2560,
    });
  });

  it("never upscales", () => {
    expect(targetDimensions({ width: 800, height: 600 }, 2560)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("leaves an image exactly at the target alone", () => {
    expect(targetDimensions({ width: 2560, height: 1440 }, 2560)).toEqual({
      width: 2560,
      height: 1440,
    });
  });

  it("never rounds a dimension down to zero", () => {
    const out = targetDimensions({ width: 10000, height: 3 }, 100);
    expect(out.width).toBe(100);
    expect(out.height).toBe(1);
  });
});

describe("presets", () => {
  it("exposes the three documented presets", () => {
    expect(PRESETS.map(p => p.id)).toEqual(["hero", "standard", "gallery"]);
  });

  it("defaults to standard at Wix's own stated minimum long edge", () => {
    expect(getPreset(DEFAULT_PRESET_ID).settings.maxLongEdge).toBe(2560);
  });

  it("keeps every preset inside what Wix can actually serve", () => {
    for (const p of PRESETS) {
      expect(p.settings.maxLongEdge).toBeLessThanOrEqual(WIX_MAX_LONG_EDGE);
    }
  });

  it("throws on an unknown id rather than silently falling back", () => {
    // @ts-expect-error deliberately invalid
    expect(() => getPreset("nope")).toThrow();
  });
});

describe("clampSettings", () => {
  const base = getPreset("standard").settings;

  it("clamps the long edge to Wix's transform ceiling", () => {
    expect(clampSettings({ ...base, maxLongEdge: 12000 }).maxLongEdge).toBe(5000);
  });

  it("clamps quality into 1-100", () => {
    expect(clampSettings({ ...base, quality: 0 }).quality).toBe(1);
    expect(clampSettings({ ...base, quality: 300 }).quality).toBe(100);
  });

  it("allows sharpening to be switched off", () => {
    expect(clampSettings({ ...base, sharpen: 0 }).sharpen).toBe(0);
  });
});
