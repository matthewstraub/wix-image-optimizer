# Wix Image Optimizer

**Live:** https://wix-image-optimizer.onrender.com

Shrink photos before uploading them to Wix, without a visible quality cost.

Everything runs in the browser. No file is uploaded, there is no server, no
account, and no tracking. There is also a command line tool in this repo for
the files a browser tab cannot handle.

## The problem

A wedding delivery in `~/Downloads` is 1,036 JPEGs and 8.1 GB — an average of
8 MB each, every one of them at least 4,076 pixels on the long edge. Uploading
that to Wix consumes a paid storage quota, and **no visitor ever receives those
bytes**: Wix re-encodes and resizes every image on delivery.

## The counterintuitive part

The obvious move is to convert everything to WebP or AVIF. That is the wrong
answer here, and measurably so.

Any Wix URL containing a `/v1/` transform — which is all of them on a real
site — is decoded and re-encoded on the way out, even at the source's own
native resolution. Measured live on a 5000×2184 asset:

| Request                 | Output pixels | Bytes                                   |
| ----------------------- | ------------- | --------------------------------------- |
| Bare URL, no `/v1/`     | 5000×2184     | 4,889,258 — the original, byte for byte |
| `/v1/fit/w_5000,h_5000` | 5000×2184     | 1,502,892                               |

Same pixels, 31% of the weight. So uploading WebP or AVIF buys nothing — Wix
converts to AVIF on the way out regardless — and feeding an already-lossy file
into that encoder stacks one generation of damage onto another.

**The saving comes from pixels, not compression.** Wix caps device pixel ratio
at 2 and clamps every transform at 5000px, so detail beyond about 3840px on the
long edge cannot be requested by anything. You are paying to store it and no
visitor will ever see it.

[RESEARCH.md](RESEARCH.md) has the measurements, the method, and the parts that
did not go the way the literature suggested.

## What it does

- **Bulk.** Drag in a folder. Subfolders are preserved all the way through to
  the output.
- **Four-pane comparison.** Click any file. The top row is what you have on
  disk; the bottom row is what Wix actually delivers from each. The bottom row
  is the only pair a visitor could tell apart, and it is the one that has to
  match.
- **Presets**, plus an Advanced panel with the raw controls.
- **Web-friendly filenames** with a suffix you choose. `DSC_0918.JPG` becomes
  `dsc-0918-optimized.jpg`. Wix puts the filename straight into the image URL.
- **sRGB conversion and metadata stripping.** A typical source here carries
  47 KB of EXIF, ICC, XMP and IPTC, including GPS.
- **Save to a folder** (Chrome and Edge), streamed straight to disk, or
  **download a ZIP** everywhere else.

## Presets

| Preset              | Long edge  | For                                                                |
| ------------------- | ---------- | ------------------------------------------------------------------ |
| Hero / full-bleed   | 3840px     | Full-width banners — true 2× for a 1920px desktop hero             |
| **Standard**        | **2560px** | Blog, content and most galleries. Matches Wix's own stated minimum |
| Gallery / thumbnail | 1600px     | Grid thumbnails and cards                                          |

All at quality 80, JPEG (MozJPEG, progressive, 4:4:4), sRGB, no metadata, and
**no sharpening** — Wix applies its own unsharp mask on every transform, so
adding ours made files both larger and worse. Images with transparency stay
lossless PNG rather than being flattened onto white.

On the source folder above, Standard projects to about **1.0 GB from 8.05 GB**.

## Running it locally

```bash
npm install && npm run dev
```

| Command                     | What it does                                  |
| --------------------------- | --------------------------------------------- |
| `npm run dev`               | Vite dev server                               |
| `npm run build`             | Production build into `dist/`                 |
| `npm test`                  | Vitest, including browser/CLI pipeline parity |
| `npm run typecheck`         | `tsc --noEmit`                                |
| `npm run lint`              | ESLint                                        |
| `npm run optimize -- <dir>` | The CLI (see below)                           |
| `npm run bench`             | The quality sweep behind the presets          |
| `npm run bench:calibrate`   | Check the Wix model against the live CDN      |

## The command line tool

The web app tops out around 100 megapixels, because PNG has no reduced-scale
decode and the full RGBA buffer has to exist before anything can resize it. The
largest file in the source folders is a 23630×19183 scan — 453 MP, 1.8 GB
decoded. The CLI has no such limit, reads TIFF natively, and mirrors the folder
tree the same way.

```bash
npm run optimize -- "~/Downloads/Wedding Photos (Grouped)" --out ./web-ready
```

| Flag                   | Default             |                                 |
| ---------------------- | ------------------- | ------------------------------- |
| `--out <dir>`          | `<input>-optimized` | Output root                     |
| `--preset <id>`        | `standard`          | `hero`, `standard` or `gallery` |
| `--suffix <text>`      | `optimized`         | Empty string for none           |
| `--quality <1-100>`    | from preset         |                                 |
| `--max-long-edge <px>` | from preset         | Capped at Wix's 5000px ceiling  |
| `--format <fmt>`       | `jpeg`              | `jpeg`, `webp`, `avif`, `png`   |
| `--sharpen <0-3>`      | `0`                 | Off; Wix sharpens for you       |
| `--concurrency <n>`    | CPU count           |                                 |
| `--dry-run`            |                     | Show the output paths and stop  |

## Deploying to Render

The repo includes a [`render.yaml`](render.yaml) blueprint. In the Render
dashboard, choose **New → Blueprint** and point it at this repo; it creates a
free static site.

To set it up by hand instead, create a **New → Static Site** with:

| Setting           | Value                     |
| ----------------- | ------------------------- |
| Build command     | `npm ci && npm run build` |
| Publish directory | `dist`                    |

Every push to `main` redeploys.

## Project layout

```
src/
  App.tsx              state, batching, download
  components/          DropZone, Controls, TotalsBar, FileTable,
                       ComparisonView, WhyJpeg
  lib/
    presets.ts         the presets and Wix's hard limits    (shared with CLI)
    filename.ts        slug, suffix, collision handling     (shared with CLI)
    probe.ts           dimensions from the header, no decode
    decode.ts          JPEG/PNG/HEIC/TIFF, colour and orientation
    pipeline.ts        resize, sharpen, encode
    unsharp.ts         libvips-shaped unsharp mask
    wix-emulate.ts     model of Wix's delivery      (shared with benchmark)
    wix-browser.ts     that model, executed with jSquash
    budget.ts          admission control by megapixels
    ingest.ts          folder traversal, relative paths
    output.ts          File System Access writer and ZIP fallback
  workers/             pool.ts, encode.worker.ts, protocol.ts
cli/
  optimize.ts          the CLI
  pipeline.ts          the same pipeline, on sharp
bench/
  calibrate.ts         Wix model vs. the live CDN
  run.ts               the quality sweep
  score.ts             SSIMULACRA2 and DSSIM
render.yaml            Render blueprint
```

## How it was verified

- **88 unit tests.** Filename slugging and collisions, preset maths, the header
  probe against real encoder output, the unsharp mask's transfer curve, the
  pixel budget's admission order, and Wix's quality tiers and rounding.
- **The header probe** was checked against 14 real files from the source
  folders, including a 320 MP PNG and a 241 MP TIFF, cross-referenced with
  `sips`. That is where two facts surfaced that synthetic fixtures would have
  hidden: TIFF stores its directory wherever it likes (byte 70,832,394 of a
  68 MB scan), and sharp enforces its own input pixel limit.
- **The Wix model** is calibrated against live `static.wixstatic.com`
  derivatives: within 4.1% on bytes and 0.63 SSIMULACRA2 on damage done, for
  the reductions the presets work at. `npm run bench:calibrate` re-runs it.
- **Browser/CLI parity** is asserted by a test: identical dimensions, sizes
  within 5%, and 2.5–3.3 mean levels of difference out of 255.
- **The web app** was driven end to end in a real browser on photos from the
  wedding folder: 14.8 MB to 2.5 MB, 83% smaller, in 11.2s.

## Licence

MIT
