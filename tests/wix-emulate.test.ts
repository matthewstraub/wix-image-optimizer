import { describe, expect, it } from "vitest";
import {
  WIX_MAX_DPR,
  WIX_SAFE_AREA,
  wixAppliesUsm,
  wixDelivery,
  wixDevicePixels,
  wixEffectiveQuality,
  wixFit,
  wixQualityForArea,
  wixWireFormat,
} from "@/lib/wix-emulate";

describe("wixQualityForArea", () => {
  it("uses the tiers read out of imageScaleDefaults", () => {
    expect(wixQualityForArea(1400 * 1400)).toBe(90);
    expect(wixQualityForArea(1400 * 1400 - 1)).toBe(85);
    expect(wixQualityForArea(600 * 600)).toBe(85);
    expect(wixQualityForArea(600 * 600 - 1)).toBe(80);
    expect(wixQualityForArea(1)).toBe(80);
  });

  it("adds 5 for PNG output", () => {
    expect(wixQualityForArea(1400 * 1400, true)).toBe(95);
  });
});

describe("wixEffectiveQuality", () => {
  it("honours an explicit q_ inside 5-90", () => {
    expect(wixEffectiveQuality(60, 1400 * 1400)).toBe(60);
    expect(wixEffectiveQuality(5, 10)).toBe(5);
    expect(wixEffectiveQuality(90, 10)).toBe(90);
  });

  it("falls back to the tier outside that range, as Wix does", () => {
    expect(wixEffectiveQuality(95, 1400 * 1400)).toBe(90);
    expect(wixEffectiveQuality(1, 1400 * 1400)).toBe(90);
    expect(wixEffectiveQuality(undefined, 1400 * 1400)).toBe(90);
  });
});

describe("wixDevicePixels", () => {
  it("caps DPR at 2, so a 3x phone still gets 2x", () => {
    expect(wixDevicePixels(400, 3)).toBe(800);
    expect(wixDevicePixels(400, WIX_MAX_DPR)).toBe(800);
    expect(wixDevicePixels(400, 1)).toBe(400);
  });
});

describe("wixFit", () => {
  const dslr = { width: 7769, height: 5827 };

  it("scales into the requested width preserving aspect ratio", () => {
    expect(wixFit(dslr, 1920)).toEqual({ width: 1920, height: 1440 });
  });

  it("never upscales", () => {
    expect(wixFit({ width: 800, height: 600 }, 1920)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("clamps to the 5000px transform ceiling", () => {
    const out = wixFit({ width: 23630, height: 19183 }, 20000);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(5000);
  });

  it("pulls back inside the 25MP safe area", () => {
    const out = wixFit({ width: 9000, height: 9000 }, 9000);
    expect(out.width * out.height).toBeLessThanOrEqual(WIX_SAFE_AREA);
  });

  it("handles a portrait source", () => {
    const out = wixFit({ width: 5435, height: 8152 }, 1920);
    expect(out).toEqual({ width: 1920, height: 2880 });
  });
});

describe("wixAppliesUsm", () => {
  it("sharpens when downscaling", () => {
    expect(wixAppliesUsm({ width: 6000, height: 4000 }, { width: 1920, height: 1280 })).toBe(true);
  });

  it("does not sharpen when the render matches the source", () => {
    expect(wixAppliesUsm({ width: 1920, height: 1280 }, { width: 1920, height: 1280 })).toBe(false);
  });
});

describe("wixWireFormat", () => {
  it("prefers AVIF, then WebP, then JPEG", () => {
    expect(wixWireFormat("image/avif,image/webp,*/*")).toBe("avif");
    expect(wixWireFormat("image/webp,*/*")).toBe("webp");
    expect(wixWireFormat("*/*")).toBe("jpeg");
  });
});

describe("wixDelivery", () => {
  const source = { width: 7769, height: 5827 };

  it("models a full-bleed hero on a retina desktop", () => {
    const d = wixDelivery({ source, cssWidth: 1920 });
    expect(d.rendered).toEqual({ width: 3840, height: 2880 });
    expect(d.format).toBe("avif");
    expect(d.applyUsm).toBe(true);
  });

  it("discards a requested quality when AVIF forces quality_auto", () => {
    const d = wixDelivery({ source, cssWidth: 1920, requestedQuality: 40 });
    expect(d.qualityAuto).toBe(true);
    expect(d.quality).toBe(75);
  });

  it("honours a requested quality on the JPEG path", () => {
    const d = wixDelivery({
      source,
      cssWidth: 1920,
      accept: "*/*",
      requestedQuality: 60,
    });
    expect(d.format).toBe("jpeg");
    expect(d.qualityAuto).toBe(false);
    expect(d.quality).toBe(60);
  });

  it("drops to the 85 tier for a small thumbnail", () => {
    const d = wixDelivery({ source, cssWidth: 400, accept: "*/*" });
    expect(d.rendered).toEqual({ width: 800, height: 600 });
    expect(d.quality).toBe(85);
  });

  it("stops sharpening once our upload is already at the render size", () => {
    const upload = { width: 2560, height: 1920 };
    const d = wixDelivery({ source: upload, cssWidth: 1280 });
    expect(d.rendered).toEqual(upload);
    expect(d.applyUsm).toBe(false);
  });
});
