#!/usr/bin/env node
/**
 * Check the whole premise against a real Wix site.
 *
 *   npm run bench:verify -- <original-media-id> <optimized-media-id>
 *
 * Everything else in bench/ reasons about an emulated Wix. This takes two
 * media IDs from a live site — the same photograph uploaded twice, once
 * untouched and once through the optimiser — and asks the question directly:
 *
 *   ideal      = the untouched original, resampled losslessly to the device
 *                raster. The best any pipeline could do.
 *   today      = SSIMULACRA2(ideal, what Wix serves from the original)
 *   optimised  = SSIMULACRA2(ideal, what Wix serves from our upload)
 *   cost       = optimised - today
 *
 * `cost` is the entire claim. Near zero means the storage saving is free.
 *
 * Both deliveries are fetched from static.wixstatic.com rather than modelled,
 * so this also tells us whether the emulator that chose the presets was
 * telling the truth.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { bytesReader, probe } from "../src/lib/probe.ts";
import { openSource } from "../cli/pipeline.ts";
import { toDisplayRaster } from "./wix-render.ts";
import { Ssimulacra2 } from "./score.ts";
import { wixDeviceBox, wixFit, WIX_MAX_DPR } from "../src/lib/wix-emulate.ts";

const CONTEXTS = [
  { id: "hero", label: "Full-bleed hero", css: { width: 1920, height: 1080 } },
  {
    id: "content",
    label: "Blog / in-content",
    css: { width: 960, height: 720 },
  },
] as const;

const AVIF_ACCEPT = "image/avif,image/webp,image/apng,*/*";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchBytes(url: string, accept: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { accept, "user-agent": UA } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The transform URL Wix's own editor emits for a fit-into-box render. */
function transformUrl(id: string, box: { width: number; height: number }) {
  return (
    `https://static.wixstatic.com/media/${id}/v1/fit/` +
    `w_${box.width},h_${box.height},al_c,q_90,usm_0.66_1.00_0.01,enc_auto/file.jpg`
  );
}

const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
const kb = (n: number) => `${Math.round(n / 1024)} KB`;

async function main(): Promise<void> {
  const [originalId, optimizedId] = process.argv.slice(2);
  if (!originalId || !optimizedId) {
    console.error(
      "Usage: npm run bench:verify -- <original-media-id> <optimized-media-id>"
    );
    process.exit(1);
  }

  const work = await mkdtemp(join(tmpdir(), "wix-verify-"));
  const scorer = new Ssimulacra2();

  try {
    const stored = {
      original: await fetchBytes(
        `https://static.wixstatic.com/media/${originalId}`,
        "*/*"
      ),
      optimized: await fetchBytes(
        `https://static.wixstatic.com/media/${optimizedId}`,
        "*/*"
      ),
    };
    const meta = {
      original: (await probe(bytesReader(stored.original)))!,
      optimized: (await probe(bytesReader(stored.optimized)))!,
    };

    console.log("Stored on Wix, counting against the site's quota:");
    for (const key of ["original", "optimized"] as const) {
      const m = meta[key];
      console.log(
        `  ${key.padEnd(10)} ${m.kind.toUpperCase().padEnd(4)} ` +
          `${m.width}x${m.height}  ${mb(stored[key].byteLength)}`
      );
    }
    const ratio = stored.original.byteLength / stored.optimized.byteLength;
    console.log(
      `  saving     ${(100 - 100 / ratio).toFixed(1)}%  (${ratio.toFixed(1)}x smaller)\n`
    );

    for (const ctx of CONTEXTS) {
      const deviceBox = wixDeviceBox(ctx.css, WIX_MAX_DPR);
      // The browser's backing store is sized from the *original*, since that
      // is what the page would show if nothing had been optimised.
      const raster = wixFit(meta.original, deviceBox);

      // Ground truth: the untouched original resampled to that raster with no
      // lossy step. Both deliveries are measured against this.
      const ideal = join(work, `${ctx.id}-ideal.png`);
      await writeFile(
        ideal,
        await openSource(stored.original)
          .autoOrient()
          .resize({
            width: raster.width,
            height: raster.height,
            fit: "fill",
            kernel: "lanczos3",
            fastShrinkOnLoad: false,
          })
          .png({ compressionLevel: 1 })
          .toBuffer()
      );

      console.log(
        `${ctx.label} — ${ctx.css.width}x${ctx.css.height} CSS at ${WIX_MAX_DPR}x ` +
          `= ${raster.width}x${raster.height} device px`
      );

      const scores: Record<string, number> = {};
      for (const key of ["original", "optimized"] as const) {
        const id = key === "original" ? originalId : optimizedId;
        const served = await fetchBytes(
          transformUrl(id, deviceBox),
          AVIF_ACCEPT
        );
        const servedMeta = await sharp(served).metadata();

        const raster2 = join(work, `${ctx.id}-${key}.png`);
        await writeFile(raster2, await toDisplayRaster(served, raster));
        scores[key] = await scorer.score(ideal, raster2);

        console.log(
          `  from ${key.padEnd(10)} wix serves ${servedMeta.width}x${servedMeta.height} ` +
            `${String(servedMeta.format).padEnd(4)} ${kb(served.byteLength).padStart(7)}   ` +
            `quality ${scores[key]!.toFixed(1)}`
        );
      }

      const cost = scores.optimized! - scores.original!;
      console.log(
        `  cost of optimising: ${cost >= 0 ? "+" : ""}${cost.toFixed(1)} SSIMULACRA2 ` +
          `${Math.abs(cost) < 1 ? "(free)" : Math.abs(cost) < 3 ? "(negligible)" : "(visible)"}\n`
      );
    }
  } finally {
    scorer.close();
    await rm(work, { recursive: true, force: true });
  }
}

await main();
