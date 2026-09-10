#!/usr/bin/env node
/**
 * Batch-optimise a folder of images for upload to Wix, mirroring its structure.
 *
 *   npm run optimize -- ./photos --out ./photos-web
 *
 * The web app does the same job for everyday batches. This exists for the
 * files a browser tab cannot safely decode — the largest source in scope is a
 * 453 megapixel scan, which needs 1.8 GB just to hold — and for anyone who
 * would rather point a command at a folder than drag 8 GB into a tab.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { cpus } from "node:os";
import sharp from "sharp";
import { processImage } from "./pipeline.ts";
import {
  clampSettings,
  DEFAULT_PRESET_ID,
  getPreset,
  PRESETS,
  WIX_MAX_UPLOAD_BYTES,
  type EncodeSettings,
  type OutputFormat,
  type PresetId,
} from "../src/lib/presets.ts";
import { outputRelativePath, uniquePath } from "../src/lib/filename.ts";
import { PixelBudget } from "../src/lib/budget.ts";

const SUPPORTED = new Set([
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "png",
  "heic",
  "heif",
  "tif",
  "tiff",
  "webp",
  "avif",
  "gif",
  "bmp",
]);

const USAGE = `
Usage: npm run optimize -- <input-dir> [options]

Options:
  --out <dir>            Output directory (default: <input-dir>-optimized)
  --preset <id>          ${PRESETS.map(p => p.id).join(" | ")}  (default: ${DEFAULT_PRESET_ID})
  --suffix <text>        Appended to each filename (default: optimized; "" for none)
  --quality <1-100>      Override the preset's quality
  --max-long-edge <px>   Override the preset's longest side
  --format <fmt>         jpeg | webp | avif | png (default: jpeg)
  --sharpen <0-3>        Unsharp amount; 0 disables (default: 1)
  --concurrency <n>      Files in flight (default: CPU count)
  --dry-run              Report what would happen without writing
  --help
`.trim();

interface Job {
  absolute: string;
  relativePath: string;
  bytes: number;
}

async function walk(root: string): Promise<Job[]> {
  const jobs: Job[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
      if (!SUPPORTED.has(ext)) continue;
      const { size } = await stat(full);
      jobs.push({
        absolute: full,
        relativePath: relative(root, full).split(sep).join("/"),
        bytes: size,
      });
    }
  }
  await visit(root);
  jobs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return jobs;
}

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: "string" },
      preset: { type: "string" },
      suffix: { type: "string" },
      quality: { type: "string" },
      "max-long-edge": { type: "string" },
      format: { type: "string" },
      sharpen: { type: "string" },
      concurrency: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const input = resolve(positionals[0]!);
  const output = resolve(values.out ?? `${input}-optimized`);
  if (output === input) {
    console.error("Refusing to write output over the input directory.");
    process.exit(1);
  }

  const presetId = (values.preset ?? DEFAULT_PRESET_ID) as PresetId;
  if (!PRESETS.some(p => p.id === presetId)) {
    console.error(
      `Unknown preset "${presetId}". Expected one of: ${PRESETS.map(p => p.id).join(", ")}`
    );
    process.exit(1);
  }

  const settings: EncodeSettings = clampSettings({
    ...getPreset(presetId).settings,
    ...(values.format ? { format: values.format as OutputFormat } : {}),
    ...(values.quality ? { quality: Number(values.quality) } : {}),
    ...(values["max-long-edge"]
      ? { maxLongEdge: Number(values["max-long-edge"]) }
      : {}),
    ...(values.sharpen !== undefined
      ? { sharpen: Number(values.sharpen) }
      : {}),
  });
  const suffix = values.suffix ?? "optimized";

  const jobs = await walk(input);
  if (jobs.length === 0) {
    console.error(`No supported images found under ${input}`);
    process.exit(1);
  }

  const sourceBytes = jobs.reduce((n, j) => n + j.bytes, 0);
  console.log(
    `${jobs.length} images, ${human(sourceBytes)} in ${input}\n` +
      `preset ${presetId} - ${settings.format} q${settings.quality} ` +
      `${settings.chroma}, long edge ${settings.maxLongEdge}px\n`
  );
  if (values["dry-run"]) {
    for (const job of jobs.slice(0, 10)) {
      console.log(
        `  ${job.relativePath}\n    -> ${outputRelativePath(job.relativePath, { suffix, ext: "jpg" })}`
      );
    }
    if (jobs.length > 10) console.log(`  ... and ${jobs.length - 10} more`);
    return;
  }

  // libvips parallelises inside a single operation, which fights with running
  // many at once. One thread each, many files at a time, is faster for a batch.
  sharp.concurrency(1);
  const parallel = Number(values.concurrency ?? cpus().length);
  // The CLI is not bounded by a browser tab, but a folder of 45 MP frames can
  // still exhaust a laptop; budget by pixels rather than by file count.
  const budget = new PixelBudget(parallel * 60, parallel);

  const taken = new Set<string>();
  let done = 0;
  let failed = 0;
  let writtenBytes = 0;
  let oversized = 0;
  const started = Date.now();

  await Promise.all(
    jobs.map(job =>
      budget.run(estimateMegapixels(job.bytes), async () => {
        try {
          const result = await processImage(job.absolute, settings);
          const target = uniquePath(
            outputRelativePath(job.relativePath, { suffix, ext: result.ext }),
            taken
          );
          const destination = join(output, target);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, result.data);

          writtenBytes += result.data.byteLength;
          if (job.bytes > WIX_MAX_UPLOAD_BYTES) oversized++;
          done++;
          report(
            done + failed,
            jobs.length,
            job.relativePath,
            job.bytes,
            result.data.byteLength
          );
        } catch (error) {
          failed++;
          process.stdout.write("\r\x1b[K");
          console.error(
            `  failed: ${job.relativePath} - ${(error as Error).message}`
          );
        }
      })
    )
  );

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write("\r\x1b[K");
  const saved = sourceBytes - writtenBytes;
  console.log(
    `\n${done} written to ${output}` +
      (failed ? `, ${failed} failed` : "") +
      `\n${human(sourceBytes)} -> ${human(writtenBytes)} ` +
      `(${((saved / sourceBytes) * 100).toFixed(1)}% smaller, ${human(saved)} saved)` +
      `\n${elapsed}s`
  );
  if (oversized > 0) {
    console.log(
      `\n${oversized} original${oversized === 1 ? " was" : "s were"} over Wix's ` +
        `50 MB upload limit and would have been rejected outright.`
    );
  }
  if (failed > 0) process.exitCode = 1;
}

/**
 * Rough pixel cost from file size, so the budget can be applied before paying
 * to open the file. Compressed photos land near 4 bytes per pixel of source.
 */
function estimateMegapixels(bytes: number): number {
  return Math.max(1, bytes / 4 / 1e6);
}

function report(
  index: number,
  total: number,
  name: string,
  before: number,
  after: number
): void {
  const pct = (((before - after) / before) * 100).toFixed(0);
  const short = name.length > 52 ? `...${name.slice(-49)}` : name;
  process.stdout.write(
    `\r\x1b[K[${index}/${total}] ${short} ${human(before)} -> ${human(after)} (-${pct}%)`
  );
}

await main();
