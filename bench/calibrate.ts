#!/usr/bin/env node
/**
 * Prove the Wix emulator against the real thing before trusting any benchmark
 * number that depends on it.
 *
 *   npm run bench:calibrate
 *
 * Downloads real assets from static.wixstatic.com — both the untouched
 * original and Wix's own derivative of it — reproduces the derivative locally,
 * and reports how close we land.
 *
 * It fits the one number that cannot be read out of Wix's published source:
 * the encoder quality that reproduces their `quality_auto` AVIF. Their quality
 * scale is not libaom's, so it has to be measured.
 *
 * Two criteria, because either alone can mislead:
 *
 *   bytes  — our AVIF should weigh what theirs weighs at the same dimensions.
 *            Two AVIF encoders at the same rate are doing the same amount of
 *            work, and bytes are objective.
 *   damage — SSIMULACRA2 of each encode against the same reference. If Wix
 *            degrades the source by X and we degrade it by X, the emulator is
 *            faithful even where the two encoders differ pixel for pixel.
 *
 * Comparing our output directly to theirs is reported too, but it is the
 * weakest of the three: two independent lossy encodes of one image differ from
 * each other by roughly the sum of their individual errors, so a middling
 * score there is expected and does not indicate a bad model.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { probe, bytesReader } from "../src/lib/probe.ts";
import { renderAsWix } from "./wix-render.ts";
import { Ssimulacra2 } from "./score.ts";
import { WIX_MAX_DPR, wixFit } from "../src/lib/wix-emulate.ts";
import { openSource } from "../cli/pipeline.ts";

/** Photographic JPEGs published on Wix-built pages. Anything public works. */
const DEFAULT_ASSETS = [
  "1a7b30_63346a695572440f8803c177dd80d14d~mv2.jpg",
  "343a2a_12586a2c56fb49fa8199aeba3d7865ca~mv2.jpg",
  "343a2a_1b041a18e2584f278ed117c03dca584e~mv2.jpg",
];

const AVIF_ACCEPT = "image/avif,image/webp,image/apng,*/*";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Device widths to calibrate at. The large one usually lands at the source's
 * native size (Wix never upscales), which isolates the encoder; the smaller
 * ones force a real downscale and exercise their unsharp mask.
 */
const RENDER_WIDTHS = [1920, 800, 400];
const QUALITY_SWEEP = [62, 66, 70, 74, 78, 82, 86, 90];

async function fetchBytes(url: string, accept: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { accept, "user-agent": UA } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

const pct = (a: number, b: number) =>
  `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%`;

interface Fit {
  asset: string;
  width: number;
  quality: number;
  byteDelta: number;
  theirDamage: number;
  ourDamage: number;
  agreement: number;
  /** Linear reduction from source to render, e.g. 4.6 for 1824px -> 400px. */
  reduction: number;
}

/**
 * Reductions at or below this are the regime we actually operate in: an
 * upload capped at 2560px, rendered by Wix at 3840 or 1920 device pixels, is
 * reduced by 1.0x to 1.33x. Fits from harsher reductions are reported but
 * excluded from the fitted quality, because Wix's own downscaler behaves
 * differently there and would drag the number somewhere unrepresentative.
 */
const OPERATING_REDUCTION = 2.5;

async function main(): Promise<void> {
  const assets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_ASSETS;
  const work = await mkdtemp(join(tmpdir(), "wix-calibrate-"));
  const scorer = new Ssimulacra2();
  const fits: Fit[] = [];
  let n = 0;

  console.log(
    `Calibrating against ${assets.length} live Wix assets at ` +
      `${RENDER_WIDTHS.join("/")}px device width\n`
  );

  try {
    for (const id of assets) {
      const base = `https://static.wixstatic.com/media/${id}`;
      const original = await fetchBytes(base, "*/*");
      const meta = await probe(bytesReader(original));
      if (!meta) {
        console.log(`skipped ${id}: dimensions unreadable\n`);
        continue;
      }
      console.log(
        `${id}\n  original ${meta.width}x${meta.height}, ` +
          `${original.length.toLocaleString()} B`
      );

      for (const width of RENDER_WIDTHS) {
        const transform =
          `${base}/v1/fit/w_${width},h_${width},al_c,q_90,` +
          `usm_0.66_1.00_0.01,enc_auto/file.jpg`;
        const theirs = await fetchBytes(transform, AVIF_ACCEPT);
        // The URL below asks for a square box, so model it as one.
        const box = { width, height: width };
        const rendered = wixFit(meta, box);

        // Reference: the original resampled to the render size and kept
        // lossless. Both encodes are measured against this, so the comparison
        // is of damage done rather than of one encoder against the other.
        const referencePng = join(work, `${n}-ref.png`);
        await writeFile(
          referencePng,
          await openSource(original)
            .autoOrient()
            .resize({
              width: rendered.width,
              height: rendered.height,
              // "fill" for the same reason as in wix-render: "inside" would
              // re-derive the box and land a pixel short of what Wix emits,
              // and the metrics refuse to score mismatched shapes.
              fit: "fill",
              kernel: "lanczos3",
              fastShrinkOnLoad: false,
            })
            .png({ compressionLevel: 1 })
            .toBuffer()
        );

        const theirsPng = join(work, `${n}-wix.png`);
        await writeFile(
          theirsPng,
          await sharp(theirs).png({ compressionLevel: 1 }).toBuffer()
        );
        const theirDamage = await scorer.score(referencePng, theirsPng);

        console.log(
          `  w_${width} -> ${rendered.width}x${rendered.height}  ` +
            `wix ${theirs.length.toLocaleString()} B, damage s2 ${theirDamage.toFixed(1)}`
        );

        let best: Fit | null = null;
        for (const quality of QUALITY_SWEEP) {
          try {
            const ours = await renderAsWix(original, meta, {
              css: {
                width: box.width / WIX_MAX_DPR,
                height: box.height / WIX_MAX_DPR,
              },
              accept: AVIF_ACCEPT,
              avifQuality: quality,
            });
            const oursPng = join(work, `${n}-ours.png`);
            await writeFile(oursPng, ours.png);
            const ourDamage = await scorer.score(referencePng, oursPng);
            const agreement = await scorer.score(theirsPng, oursPng);
            const byteDelta = ours.bytes.length / theirs.length - 1;

            const candidate: Fit = {
              asset: id,
              width,
              quality,
              byteDelta,
              theirDamage,
              ourDamage,
              agreement,
              reduction: meta.width / rendered.width,
            };
            console.log(
              `    q${String(quality).padStart(2)}  ` +
                `${ours.bytes.length.toLocaleString().padStart(9)} B ` +
                `${pct(ours.bytes.length, theirs.length).padStart(7)}   ` +
                `damage s2 ${ourDamage.toFixed(1).padStart(5)}   ` +
                `vs wix s2 ${agreement.toFixed(1)}`
            );
            if (
              !best ||
              Math.abs(Math.log1p(byteDelta)) <
                Math.abs(Math.log1p(best.byteDelta))
            ) {
              best = candidate;
            }
          } catch (error) {
            // One unscoreable pair should not abandon the whole calibration.
            console.log(
              `    q${quality}  skipped: ${(error as Error).message}`
            );
          }
        }
        if (best) {
          fits.push(best);
          console.log(
            `    best q${best.quality}: ${pct(1 + best.byteDelta, 1)} bytes, ` +
              `damage ${best.ourDamage.toFixed(1)} vs wix ${best.theirDamage.toFixed(1)} ` +
              `(${(best.ourDamage - best.theirDamage >= 0 ? "+" : "") + (best.ourDamage - best.theirDamage).toFixed(1)})`
          );
        }
        n++;
      }
      console.log();
    }

    if (fits.length === 0) {
      console.error("Nothing could be calibrated.");
      process.exitCode = 1;
      return;
    }

    const inRegime = fits.filter(f => f.reduction <= OPERATING_REDUCTION);
    const harsh = fits.filter(f => f.reduction > OPERATING_REDUCTION);
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const mean = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

    const report = (label: string, group: Fit[]) => {
      if (group.length === 0) return;
      console.log(
        `${label} (${group.length} fits, reduction ` +
          `${Math.min(...group.map(f => f.reduction)).toFixed(1)}x-` +
          `${Math.max(...group.map(f => f.reduction)).toFixed(1)}x)\n` +
          `  qualities        ${group
            .map(f => f.quality)
            .sort((a, b) => a - b)
            .join(", ")}\n` +
          `  mean |byte err|  ${(mean(group.map(f => Math.abs(f.byteDelta))) * 100).toFixed(1)}%\n` +
          `  damage gap       ${signed(mean(group.map(f => f.ourDamage - f.theirDamage)))} SSIMULACRA2`
      );
    };

    console.log("\u2500".repeat(72));
    report("Operating regime", inRegime);
    if (harsh.length) {
      console.log();
      report("Harsher reductions", harsh);
      console.log(
        "  Wix degrades small renders far more than a lanczos3 downscale does\n" +
          "  at the same byte size, so the emulator is optimistic here. This is\n" +
          "  outside the band the presets operate in; see RESEARCH.md."
      );
    }

    const fitted = median(
      (inRegime.length ? inRegime : fits).map(f => f.quality)
    );
    const gap = mean(inRegime.map(f => f.ourDamage - f.theirDamage));
    console.log(
      `\n${
        Math.abs(gap) <= 3
          ? "Damage matches within 3 SSIMULACRA2 in the operating regime. Emulator is faithful."
          : gap > 3
            ? "Emulator is optimistic in the operating regime; treat results as a lower bound."
            : "Emulator is pessimistic in the operating regime; treat results as an upper bound."
      }`
    );
    console.log(`\nSet AVIF_AUTO_QUALITY = ${fitted} in bench/wix-render.ts`);
  } finally {
    scorer.close();
    await rm(work, { recursive: true, force: true });
  }
}

await main();
