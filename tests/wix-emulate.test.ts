import { describe, expect, it } from "vitest";
import {
  WIX_MAX_DPR,
  WIX_SAFE_AREA,
  wixAppliesUsm,
  wixDelivery,
  wixDeviceBox,
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

describe("wixDeviceBox", () => {
  const css = { width: 400, height: 300 };

  it("caps DPR at 2, so a 3x phone still gets 2x", () => {
    expect(wixDeviceBox(css, 3)).toEqual({ width: 800, height: 600 });
    expect(wixDeviceBox(css, WIX_MAX_DPR)).toEqual({ width: 800, height: 600 });
    expect(wixDeviceBox(css, 1)).toEqual({ width: 400, height: 300 });
  });
});

describe("wixFit", () => {
  const dslr = { width: 7769, height: 5827 };

  it("scales into the requested width preserving aspect ratio", () => {
    expect(wixFit(dslr, { width: 1920, height: 1920 })).toEqual({
      width: 1920,
      height: 1440,
    });
  });

  it("never upscales", () => {
    expect(
      wixFit({ width: 800, height: 600 }, { width: 1920, height: 1920 })
    ).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("clamps to the 5000px transform ceiling", () => {
    const out = wixFit(
      { width: 23630, height: 19183 },
      { width: 20000, height: 20000 }
    );
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(5000);
  });

  it("pulls back inside the 25MP safe area", () => {
    const out = wixFit(
      { width: 9000, height: 9000 },
      { width: 9000, height: 9000 }
    );
    expect(out.width * out.height).toBeLessThanOrEqual(WIX_SAFE_AREA);
  });

  it("binds on height for a portrait source, not width", () => {
    // 8152 is the long edge, so it hits the 1920 box first and width follows:
    // 5435 * 1920/8152 = 1280.1, floored.
    const out = wixFit(
      { width: 5435, height: 8152 },
      { width: 1920, height: 1920 }
    );
    expect(out).toEqual({ width: 1280, height: 1920 });
  });

  it("uses whichever dimension of a non-square box binds first", () => {
    const portrait = { width: 3578, height: 5377 };
    const hero = { width: 3840, height: 2160 };
    // Height binds: a tall frame in a wide hero is nowhere near 3840 across.
    // Modelling the box as width-only produced a 22 megapixel render here.
    expect(wixFit(portrait, hero)).toEqual({ width: 1437, height: 2160 });

    const landscape = { width: 7769, height: 5827 };
    expect(wixFit(landscape, hero)).toEqual({ width: 2879, height: 2160 });
  });

  it("floors the derived edge, as Wix does", () => {
    // Verified against live derivatives of a 1824x1270 asset. Rounding would
    // give 279 / 627 / 766 and be one pixel out.
    const source = { width: 1824, height: 1270 };
    expect(wixFit(source, { width: 400, height: 400 })).toEqual({
      width: 400,
      height: 278,
    });
    expect(wixFit(source, { width: 900, height: 900 })).toEqual({
      width: 900,
      height: 626,
    });
    expect(wixFit(source, { width: 1100, height: 1100 })).toEqual({
      width: 1100,
      height: 765,
    });
    // And agrees with rounding where flooring is not the difference.
    expect(wixFit(source, { width: 500, height: 500 })).toEqual({
      width: 500,
      height: 348,
    });
    expect(wixFit(source, { width: 1300, height: 1300 })).toEqual({
      width: 1300,
      height: 905,
    });
  });
});

describe("wixAppliesUsm", () => {
  it("sharpens when downscaling", () => {
    expect(
      wixAppliesUsm(
        { width: 6000, height: 4000 },
        { width: 1920, height: 1280 },
        "fill"
      )
    ).toBe(true);
  });

  it("sharpens a fit transform even at native size, per isUSMNeeded", () => {
    // The editor emits `fit`, and its clause in isUSMNeeded is unconditional.
    // Modelling this was what made calibration line up.
    const same = { width: 1920, height: 1280 };
    expect(wixAppliesUsm(same, same, "fit")).toBe(true);
    expect(wixAppliesUsm(same, same, "fill")).toBe(false);
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
    const d = wixDelivery({ source, css: { width: 1920, height: 1920 } });
    // A square 1920 CSS box at 2x is 3840 across; 5827 * 3840/7769 = 2880.02,
    // so flooring lands on 2880.
    expect(d.rendered).toEqual({ width: 3840, height: 2880 });
    expect(d.format).toBe("avif");
    expect(d.applyUsm).toBe(true);
  });

  it("discards a requested quality when AVIF forces quality_auto", () => {
    const d = wixDelivery({
      source,
      css: { width: 1920, height: 1920 },
      requestedQuality: 40,
    });
    expect(d.qualityAuto).toBe(true);
    expect(d.quality).toBe(75);
  });

  it("honours a requested quality on the JPEG path", () => {
    const d = wixDelivery({
      source,
      css: { width: 1920, height: 1920 },
      accept: "*/*",
      requestedQuality: 60,
    });
    expect(d.format).toBe("jpeg");
    expect(d.qualityAuto).toBe(false);
    expect(d.quality).toBe(60);
  });

  it("drops to the 85 tier for a small thumbnail", () => {
    const d = wixDelivery({
      source,
      css: { width: 400, height: 400 },
      accept: "*/*",
    });
    expect(d.rendered).toEqual({ width: 800, height: 600 });
    expect(d.quality).toBe(85);
  });

  it("still sharpens a fit delivery at native size", () => {
    const upload = { width: 2560, height: 1920 };
    const d = wixDelivery({
      source: upload,
      css: { width: 1280, height: 1280 },
    });
    expect(d.rendered).toEqual(upload);
    expect(d.applyUsm).toBe(true);
  });

  it("skips the sharpen for a fill delivery at native size", () => {
    const upload = { width: 2560, height: 1920 };
    const d = wixDelivery({
      source: upload,
      css: { width: 1280, height: 1280 },
      transform: "fill",
    });
    expect(d.applyUsm).toBe(false);
  });
});
