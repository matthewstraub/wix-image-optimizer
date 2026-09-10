import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { bytesReader, probe, probeBytes } from "@/lib/probe";

/**
 * Every fixture here is produced by a real encoder rather than hand-assembled,
 * so the parser is checked against bytes it will actually meet in the wild.
 */
const source = (w: number, h: number) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  });

describe("probeBytes", () => {
  it("reads a baseline JPEG", async () => {
    const buf = await source(7769, 5827).jpeg().toBuffer();
    expect(probeBytes(buf)).toMatchObject({
      kind: "jpeg",
      width: 7769,
      height: 5827,
    });
  });

  it("reads a progressive JPEG", async () => {
    const buf = await source(1234, 567).jpeg({ progressive: true }).toBuffer();
    expect(probeBytes(buf)).toMatchObject({
      kind: "jpeg",
      width: 1234,
      height: 567,
    });
  });

  it("finds the frame header behind a large EXIF and ICC block", async () => {
    const buf = await source(4000, 3000)
      .withExif({ IFD0: { Copyright: "x".repeat(2000) } })
      .withIccProfile("p3")
      .jpeg()
      .toBuffer();
    expect(probeBytes(buf)).toMatchObject({ width: 4000, height: 3000 });
  });

  it("reads a PNG", async () => {
    const buf = await source(1600, 1200).png().toBuffer();
    expect(probeBytes(buf)).toMatchObject({
      kind: "png",
      width: 1600,
      height: 1200,
    });
  });

  it("reads a 453 megapixel PNG header without decoding it", async () => {
    // The file that motivated header probing in the first place is
    // 23630x19183 — 1.8 GB once decoded. Patch a real PNG's IHDR instead of
    // allocating that, since the probe only ever looks at the header.
    const buf = await source(16, 16).png().toBuffer();
    buf.writeUInt32BE(23630, 16);
    buf.writeUInt32BE(19183, 20);
    const out = probeBytes(buf)!;
    expect(out).toMatchObject({ kind: "png", width: 23630, height: 19183 });
    expect(out.megapixels).toBeCloseTo(453.3, 0);
  });

  it("reads lossy and lossless WebP", async () => {
    const lossy = await source(800, 600).webp().toBuffer();
    expect(probeBytes(lossy)).toMatchObject({
      kind: "webp",
      width: 800,
      height: 600,
    });
    const lossless = await source(800, 600).webp({ lossless: true }).toBuffer();
    expect(probeBytes(lossless)).toMatchObject({
      kind: "webp",
      width: 800,
      height: 600,
    });
  });

  it("reads AVIF via the ISO-BMFF path", async () => {
    const buf = await source(640, 480).avif({ effort: 0 }).toBuffer();
    expect(probeBytes(buf)).toMatchObject({
      kind: "avif",
      width: 640,
      height: 480,
    });
  });

  it("reads a TIFF whose directory sits after the image data", async () => {
    // Real scanner output — and sharp's own writer — put the IFD at the end.
    // The Ferrwood scans have it at byte 70,832,394 of a 68 MB file, so the
    // front-of-file probe legitimately finds nothing and `probe` must follow
    // the pointer.
    const buf = await source(4800, 7080).tiff().toBuffer();
    expect(probeBytes(buf.subarray(0, 128 * 1024))).toBeNull();
    await expect(probe(bytesReader(buf))).resolves.toMatchObject({
      kind: "tiff",
      width: 4800,
      height: 7080,
    });
  });

  it("declines BigTIFF rather than mis-parsing it", async () => {
    const buf = await source(64, 64).tiff().toBuffer();
    buf.writeUInt16BE(43, 2); // BigTIFF magic
    await expect(probe(bytesReader(buf))).resolves.toBeNull();
  });

  it("reads a GIF", async () => {
    const buf = await source(120, 90).gif().toBuffer();
    expect(probeBytes(buf)).toMatchObject({
      kind: "gif",
      width: 120,
      height: 90,
    });
  });

  it("computes megapixels", async () => {
    const buf = await source(2000, 1000).jpeg().toBuffer();
    expect(probeBytes(buf)!.megapixels).toBe(2);
  });

  it("returns null for a non-image rather than guessing", async () => {
    const junk = new TextEncoder().encode("this is not an image at all, truly");
    expect(probeBytes(junk)).toBeNull();
    await expect(probe(bytesReader(junk))).resolves.toBeNull();
  });

  it("returns null for a truncated file rather than throwing", async () => {
    const buf = await source(4000, 3000).jpeg().toBuffer();
    expect(() => probeBytes(buf.subarray(0, 4))).not.toThrow();
    expect(probeBytes(buf.subarray(0, 4))).toBeNull();
  });
});
