#!/usr/bin/env node
/**
 * The benchmark that chooses the preset numbers.
 *
 *   npm run bench -- [--fixtures <dir>] [--parallel 4]
 *
 * The question is not "how close is our upload to the original" — nobody ever
 * sees the original, because Wix re-encodes on every /v1/ transform URL. The
 * question is whether a visitor could tell that a page was built from our
 * upload rather than from the untouched original.
 *
 * The obvious experiment is to score Wix's delivery of our upload against
 * Wix's delivery of the original. That is wrong, and measurably so: both are
 * independent lossy AVIF encodes, so the score picks up the sum of two
 * encoders' artifacts rather than the difference in quality between the two
 * paths. It bottoms out around 75 even for an upload that costs nothing.
 *
 * So both paths are measured against a common, lossless ground truth instead:
 *
 *   ideal      = the original, resampled losslessly to the device raster
 *   today      = SSIMULACRA2(ideal, browser-raster(wix(original)))
 *   optimised  = SSIMULACRA2(ideal, browser-raster(wix(our upload)))
 *   cost       = optimised - today
 *
 * `today` is the quality a visitor already gets — Wix's own re-encode is not
 * free, and knowing how much it costs is half the argument. `cost` is what our
 * optimisation adds on top. A cost near zero means the storage saving is free.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { bytesReader, probe } from "../src/lib/probe.ts";
import { openSource, processImage } from "../cli/pipeline.ts";
import { renderAsWix, toDisplayRaster } from "./wix-render.ts";
import { Ssimulacra2Pool } from "./score.ts";
import { wixDeviceBox, wixFit, WIX_MAX_DPR } from "../src/lib/wix-emulate.ts";
import { PixelBudget } from "../src/lib/budget.ts";
import type { ChromaSubsampling, EncodeSettings } from "../src/lib/presets.ts";

/**
 * Page contexts, as CSS boxes. Both dimensions matter: a portrait frame in a
 * wide hero is limited by height, and treating the box as width-only turns a
 * 5377px-tall source into a 22 megapixel render nothing would request.
 */
const CONTEXTS = [
  { id: "hero", label: "Full-bleed hero", css: { width: 1920, height: 1080 } },
  {
    id: "content",
    label: "Blog / in-content",
    css: { width: 960, height: 720 },
  },
] as const;

const LONG_EDGES = [1600, 2048, 2560, 3200, 3840];
const QUALITIES = [80, 84, 88, 92];

/**
 * SSIMULACRA2 points we are willing to give up against what Wix already
 * delivers from the original. One point is far below anything visible; three
 * is the outer edge of defensible.
 */
const FREE = 1.0;
const NEGLIGIBLE = 3.0;

interface Row {
  photo: string;
  longEdge: number;
  quality: number;
  chroma: ChromaSubsampling;
  sharpen: number;
  sourceBytes: number;
  uploadBytes: number;
  uploadWidth: number;
  uploadHeight: number;
  today: Record<string, number>;
  optimised: Record<string, number>;
}

async function collectFixtures(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(d: string): Promise<void> {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.(jpe?g|png|tiff?|heic)$/i.test(entry.name)) out.push(full);
    }
  }
  await visit(dir);
  return out.sort();
}

const human = (b: number) =>
  b >= 1024 ** 2
    ? `${(b / 1024 ** 2).toFixed(2)} MB`
    : `${Math.round(b / 1024)} KB`;

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      fixtures: { type: "string" },
      parallel: { type: "string" },
      out: { type: "string" },
      "long-edges": { type: "string" },
      qualities: { type: "string" },
      chroma: { type: "string" },
      sharpen: { type: "string" },
      limit: { type: "string" },
      label: { type: "string" },
    },
  });

  const fixturesDir = values.fixtures ?? "bench/fixtures/sample";
  const outDir = values.out ?? "bench/results";
  const label = values.label ?? "sweep";
  const parallel = Number(values.parallel ?? 4);

  const numbers = (raw: string | undefined, fallback: number[]) =>
    raw ? raw.split(",").map(Number) : fallback;
  const longEdges = numbers(values["long-edges"], LONG_EDGES);
  const qualities = numbers(values.qualities, QUALITIES);
  const chromas = (values.chroma?.split(",") as ChromaSubsampling[]) ?? [
    "4:4:4",
  ];
  const sharpens = numbers(values.sharpen, [1]);

  let photos = await collectFixtures(fixturesDir);
  if (values.limit) photos = photos.slice(0, Number(values.limit));
  if (photos.length === 0) {
    console.error(`No fixtures under ${fixturesDir}`);
    process.exit(1);
  }

  const grid: EncodeSettings[] = [];
  for (const maxLongEdge of longEdges) {
    for (const quality of qualities) {
      for (const chroma of chromas) {
        for (const sharpen of sharpens) {
          grid.push({ format: "jpeg", quality, chroma, maxLongEdge, sharpen });
        }
      }
    }
  }

  const total = photos.length * grid.length * CONTEXTS.length;
  console.log(
    `${photos.length} photos x ${grid.length} settings x ${CONTEXTS.length} contexts ` +
      `= ${total} comparisons\n` +
      `long edges ${longEdges.join("/")}  quality ${qualities.join("/")}  ` +
      `chroma ${chromas.join("/")}  sharpen ${sharpens.join("/")}\n`
  );

  sharp.concurrency(1);
  const scorer = new Ssimulacra2Pool(parallel);
  const gate = new PixelBudget(parallel * 40, parallel);
  const rows: Row[] = [];
  let completed = 0;
  const started = Date.now();

  const tick = () => {
    completed++;
    const elapsed = (Date.now() - started) / 1000;
    const eta = (elapsed / completed) * (total - completed);
    process.stdout.write(
      `\r\x1b[K${completed}/${total}  ${((completed / total) * 100).toFixed(0)}%  ` +
        `elapsed ${(elapsed / 60).toFixed(1)}m  eta ${(eta / 60).toFixed(1)}m`
    );
  };

  try {
    await Promise.all(
      photos.map(photo =>
        gate.run(40, async () => {
          const work = await mkdtemp(join(tmpdir(), "wix-bench-"));
          try {
            const bytes = await readFile(photo);
            const meta = await probe(bytesReader(bytes));
            if (!meta) throw new Error("dimensions unreadable");
            const name = relative(fixturesDir, photo).split(sep).join("/");

            const baseline: Record<
              string,
              {
                ideal: string;
                raster: { width: number; height: number };
                today: number;
              }
            > = {};

            for (const ctx of CONTEXTS) {
              // The browser's backing store for this element: the source
              // fitted into the CSS box, at the device pixel ratio.
              const raster = wixFit(meta, wixDeviceBox(ctx.css, WIX_MAX_DPR));

              // Ground truth: the original resampled to that raster with no
              // lossy step anywhere.
              const ideal = join(work, `ideal-${ctx.id}.png`);
              await writeFile(
                ideal,
                await openSource(bytes)
                  .autoOrient()
                  .resize({
                    ...raster,
                    fit: "fill",
                    kernel: "lanczos3",
                    fastShrinkOnLoad: false,
                  })
                  .png({ compressionLevel: 1 })
                  .toBuffer()
              );

              // What a visitor sees today.
              const delivered = await renderAsWix(bytes, meta, {
                css: ctx.css,
              });
              const todayPath = join(work, `today-${ctx.id}.png`);
              await writeFile(
                todayPath,
                await toDisplayRaster(delivered.bytes, raster)
              );
              const today = await scorer.score(ideal, todayPath);
              await rm(todayPath, { force: true });
              baseline[ctx.id] = { ideal, raster, today };
            }

            for (const settings of grid) {
              const upload = await processImage(bytes, settings);
              const row: Row = {
                photo: name,
                longEdge: settings.maxLongEdge,
                quality: settings.quality,
                chroma: settings.chroma,
                sharpen: settings.sharpen,
                sourceBytes: bytes.byteLength,
                uploadBytes: upload.data.byteLength,
                uploadWidth: upload.width,
                uploadHeight: upload.height,
                today: {},
                optimised: {},
              };

              for (const ctx of CONTEXTS) {
                const base = baseline[ctx.id]!;
                row.today[ctx.id] = base.today;
                const delivered = await renderAsWix(
                  upload.data,
                  { width: upload.width, height: upload.height },
                  { css: ctx.css }
                );
                const candidate = join(work, `cand-${ctx.id}.png`);
                await writeFile(
                  candidate,
                  await toDisplayRaster(delivered.bytes, base.raster)
                );
                try {
                  row.optimised[ctx.id] = await scorer.score(
                    base.ideal,
                    candidate
                  );
                } catch (error) {
                  process.stdout.write("\r\x1b[K");
                  console.error(
                    `  score failed ${name} ${settings.maxLongEdge}/` +
                      `${settings.quality} ${ctx.id}: ${(error as Error).message}`
                  );
                }
                await rm(candidate, { force: true });
                tick();
              }
              rows.push(row);
            }
          } catch (error) {
            process.stdout.write("\r\x1b[K");
            console.error(`  ${photo}: ${(error as Error).message}`);
          } finally {
            await rm(work, { recursive: true, force: true });
          }
        })
      )
    );
  } finally {
    scorer.close();
  }

  process.stdout.write("\r\x1b[K");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${label}.json`), JSON.stringify(rows, null, 2));
  await writeFile(join(outDir, `${label}.csv`), toCsv(rows));
  summarise(rows);
  console.log(`\nRaw results in ${outDir}/${label}.{json,csv}`);
}

function toCsv(rows: Row[]): string {
  const header = [
    "photo",
    "longEdge",
    "quality",
    "chroma",
    "sharpen",
    "sourceBytes",
    "uploadBytes",
    "uploadWidth",
    "uploadHeight",
    ...CONTEXTS.flatMap(c => [
      `today_${c.id}`,
      `optimised_${c.id}`,
      `cost_${c.id}`,
    ]),
  ];
  const lines = rows.map(r =>
    [
      JSON.stringify(r.photo),
      r.longEdge,
      r.quality,
      r.chroma,
      r.sharpen,
      r.sourceBytes,
      r.uploadBytes,
      r.uploadWidth,
      r.uploadHeight,
      ...CONTEXTS.flatMap(c => {
        const today = r.today[c.id];
        const opt = r.optimised[c.id];
        return [
          today?.toFixed(3) ?? "",
          opt?.toFixed(3) ?? "",
          today !== undefined && opt !== undefined
            ? (opt - today).toFixed(3)
            : "",
        ];
      }),
    ].join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

interface Summary {
  longEdge: number;
  quality: number;
  chroma: string;
  sharpen: number;
  bytes: number;
  share: number;
  cost: Record<string, number>;
  worst: number;
}

function summarise(rows: Row[]): void {
  if (rows.length === 0) {
    console.error("No rows produced.");
    process.exitCode = 1;
    return;
  }

  const photos = [...new Set(rows.map(r => r.photo))];
  console.log(
    `\nWhat Wix's own re-encode already costs, before we touch anything\n` +
      `(SSIMULACRA2 against a lossless render of the original):`
  );
  for (const ctx of CONTEXTS) {
    const today = mean(
      photos
        .map(p => rows.find(r => r.photo === p)!.today[ctx.id])
        .filter((n): n is number => n !== undefined)
    );
    console.log(`  ${ctx.label.padEnd(20)} ${today.toFixed(1)}`);
  }

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = [row.longEdge, row.quality, row.chroma, row.sharpen].join("|");
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(row);
  }

  const summaries: Summary[] = [];
  for (const [key, group] of groups) {
    const [longEdge, quality, chroma, sharpen] = key.split("|");
    const cost: Record<string, number> = {};
    for (const ctx of CONTEXTS) {
      cost[ctx.id] = mean(
        group
          .filter(r => r.optimised[ctx.id] !== undefined)
          .map(r => r.optimised[ctx.id]! - r.today[ctx.id]!)
      );
    }
    const bytes = mean(group.map(r => r.uploadBytes));
    summaries.push({
      longEdge: Number(longEdge),
      quality: Number(quality),
      chroma: chroma!,
      sharpen: Number(sharpen),
      bytes,
      share: bytes / mean(group.map(r => r.sourceBytes)),
      cost,
      worst: Math.min(...CONTEXTS.map(c => cost[c.id]!)),
    });
  }
  summaries.sort(
    (a, b) =>
      a.longEdge - b.longEdge ||
      a.quality - b.quality ||
      a.chroma.localeCompare(b.chroma) ||
      a.sharpen - b.sharpen
  );

  const varying = {
    chroma: new Set(summaries.map(s => s.chroma)).size > 1,
    sharpen: new Set(summaries.map(s => s.sharpen)).size > 1,
  };
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
  const describe = (s: Summary) =>
    `${s.longEdge}px q${s.quality}` +
    (varying.chroma ? ` ${s.chroma}` : "") +
    (varying.sharpen ? ` sharpen ${s.sharpen}` : "");

  console.log(
    `\nCost of optimising, in SSIMULACRA2 points against that baseline.\n` +
      `Negative is worse than today; around zero means the saving is free.\n` +
      `Mean over ${photos.length} photos.\n`
  );
  const header = [
    "long edge".padStart(9),
    " q",
    varying.chroma ? " chroma" : "",
    varying.sharpen ? " sharp" : "",
    "      upload",
    " of source",
    ...CONTEXTS.map(c => c.id.padStart(9)),
    "  verdict",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const s of summaries) {
    console.log(
      [
        String(s.longEdge).padStart(9),
        String(s.quality).padStart(2),
        varying.chroma ? s.chroma.padStart(6) : "",
        varying.sharpen ? String(s.sharpen).padStart(5) : "",
        human(s.bytes).padStart(12),
        `${(s.share * 100).toFixed(1)}%`.padStart(9),
        ...CONTEXTS.map(c => signed(s.cost[c.id]!).padStart(9)),
        `  ${s.worst >= -FREE ? "free" : s.worst >= -NEGLIGIBLE ? "negligible" : "visible"}`,
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  const front = summaries.filter(
    a =>
      !summaries.some(b => b !== a && b.bytes <= a.bytes && b.worst >= a.worst)
  );
  console.log(`\nPareto front (nothing else is both smaller and better):`);
  for (const s of front.sort((a, b) => a.bytes - b.bytes)) {
    console.log(
      `  ${describe(s).padEnd(26)} ${human(s.bytes).padStart(10)}  ` +
        `${(s.share * 100).toFixed(1).padStart(5)}% of source  ` +
        `worst cost ${signed(s.worst)}`
    );
  }

  for (const [name, threshold] of [
    ["free", FREE],
    ["negligible", NEGLIGIBLE],
  ] as const) {
    const pick = summaries
      .filter(s => s.worst >= -threshold)
      .sort((a, b) => a.bytes - b.bytes)[0];
    console.log(
      pick
        ? `\nSmallest ${name} setting (cost >= -${threshold.toFixed(1)}): ` +
            `${describe(pick)} at ${human(pick.bytes)}, ` +
            `${(pick.share * 100).toFixed(1)}% of source`
        : `\nNothing qualified as ${name}.`
    );
  }
}

await main();
