# What actually works for images on Wix

Measurements behind the presets in [`src/lib/presets.ts`](src/lib/presets.ts).
Everything here was measured on 12 photos from a real client delivery
(a wedding: 1,036 JPEGs, 8.1 GB, 4,076–8,256px on the long edge, all sRGB),
stratified across the four shoot phases so daylight, indoor and high-ISO
low-light are all represented.

Reproduce with `npm run bench` and `npm run bench:calibrate`.

---

## Summary

1. **Wix re-encodes every image on delivery**, so the format you upload is
   thrown away. Upload JPEG, not WebP or AVIF.
2. **The saving comes from resolution, not compression.** Quality 72 to 88
   moves measured quality by about 2 points while doubling the file. Long edge
   2560 to 3840 moves it by 12.
3. **Do not sharpen.** This is the opposite of standard advice for downscaling,
   and it is the largest single finding here. Wix applies its own unsharp mask
   on every transform the editor emits, so anything you add stacks on theirs.
   Turning our sharpening off made files _both_ smaller _and_ better.
4. **Wix's own pipeline is the dominant quality cost**, not ours. It takes a
   perfect render down to about 76.6 on the SSIMULACRA2 scale before we touch
   anything.

---

## How this was measured

The obvious experiment — compare our upload to the original — answers a
question nobody experiences, because nobody ever sees the original. Wix
re-encodes on every `/v1/` transform URL, including at the source's own native
resolution.

The next-most-obvious experiment — compare Wix's render of our upload against
Wix's render of the original — is also wrong, and measurably so. Both are
independent lossy AVIF encodes, so the score picks up the sum of two encoders'
artifacts rather than the difference in quality between the two paths. It
bottoms out around 75 even for an upload that costs nothing.

So both paths are measured against a common, lossless ground truth:

```
ideal      = the original, resampled losslessly to the device raster
today      = SSIMULACRA2(ideal, browser-raster(wix(original)))
optimised  = SSIMULACRA2(ideal, browser-raster(wix(our upload)))
cost       = optimised - today
```

`browser-raster` matters and is easy to miss. Wix never upscales, so a 2560px
upload comes back at 2560px and the **browser** stretches it to fill a 3840px
hero. Without modelling that final scale, the comparison is between
different-sized images and is not scoreable at all.

Two page contexts, as CSS boxes at Wix's 2× device-pixel-ratio ceiling: a
full-bleed hero (1920×1080) and an in-content or blog image (960×720).

**Metric.** SSIMULACRA2, via the reference implementation. Its published
calibration is what makes it useful here: 90 is visually lossless in a flicker
test at 1:1, 70 is high quality with artifacts perceptible but not annoying,
50 is medium. DSSIM is used as a cross-check during calibration.

### Is the Wix model trustworthy?

It has to be, or none of the above means anything. `npm run bench:calibrate`
downloads real assets from `static.wixstatic.com` — both the untouched
original and Wix's own derivative of it — reproduces the derivative locally,
and compares.

At the reductions these presets operate at (1.0–2.3×):

|                                |                       |
| ------------------------------ | --------------------- |
| Mean absolute byte error       | **4.1%**              |
| Mean damage gap (ours − Wix's) | **+0.63 SSIMULACRA2** |

Three corrections were needed to get there, each found by the calibration
disagreeing with reality rather than by reading documentation:

- **Wix sharpens on every `fit` transform**, not only when downscaling.
  `isUSMNeeded` has an unconditional clause for it, and `fit` is what the
  editor emits. This one turned out to matter enormously — see below.
- **Wix floors the derived edge** where the obvious implementation rounds.
  On a 1824×1270 asset: `w_400` gives 278 not 279, `w_900` gives 626 not 627,
  `w_1100` gives 765 not 766.
- **Both dimensions bind.** The URL carries `w_` and `h_` together, so a
  portrait frame in a wide hero is limited by height. Modelling the box as
  width-only turned a 3578×5377 source into a 22-megapixel render nothing
  would ever request.

**Known limitation.** Above about 2.5× reduction the model is optimistic — at
4.6× it scores 31 points better than Wix's real output at the same byte size,
because Wix's downscaler is much cheaper than Lanczos3. That is a real finding
about Wix's thumbnails, and it is outside the band the presets work in, but it
means small-render numbers here should not be trusted.

---

## Finding 1: Wix re-encodes everything

Measured live on a 5000×2184 asset:

| Request                      | Output pixels | Bytes                                   |
| ---------------------------- | ------------- | --------------------------------------- |
| Bare URL, no `/v1/`          | 5000×2184     | 4,889,258 — the original, byte for byte |
| `/v1/fit/w_5000,h_5000`      | 5000×2184     | 1,502,892                               |
| `/v1/fit/w_5000,h_5000,q_90` | 5000×2184     | 1,502,892                               |

Same pixels, 31% of the weight, and identical with and without an explicit
quality — because 90 is already the tier default at that size. The bare URL is
the only pass-through path, and Wix's editor never emits one.

Their delivery defaults, read from the published `@wix/image-kit` bundle and
confirmed by request:

|                    |                                                                          |
| ------------------ | ------------------------------------------------------------------------ |
| Unsharp mask       | `usm_0.66_1.00_0.01`, on every `fit` transform                           |
| Quality            | tiered by rendered area: 90 above ~1400×1400, 85 above ~600×600, else 80 |
| Format             | `enc_auto` negotiates AVIF → WebP → JPEG from the `Accept` header        |
| Quality override   | `quality_auto` ships with AVIF and **discards any `q_` you ask for**     |
| Device pixel ratio | capped at 2 — a 3× phone still gets 2×                                   |
| Transform ceiling  | 5000px per edge, 25 MP total                                             |

**Consequence.** Uploading WebP or AVIF is the worst of both worlds: the same
re-encode happens, plus a generation of damage from your own encode. And
anything beyond 3840px on the long edge cannot be requested by any delivery
path — it is storage you pay for and no visitor receives.

The storage side of the premise holds too: the **original** is what counts
against quota. Derivatives are CDN-cached and free.

---

## Finding 2: do not sharpen

Standard advice for downscaling a photo is to apply a light unsharp mask
afterwards, because resampling costs micro-contrast. That advice assumes you
control delivery. On Wix you do not, and it is wrong.

Long edge 3840, quality 80, varying only the sharpening amount:

| Sharpening | Upload      | Hero     | In-content |
| ---------- | ----------- | -------- | ---------- |
| **0**      | **1.20 MB** | **−7.3** | **−1.3**   |
| 0.5        | 1.25 MB     | −12.1    | −4.2       |
| 1.0        | 1.29 MB     | −15.9    | −6.3       |
| 1.5        | 1.33 MB     | −18.5    | −7.6       |

Not sharpening is **strictly dominant** — smaller files _and_ better quality,
at every resolution tested. At 2560px the same pattern holds: −19.9 at
sharpen 0 against −28.5 at sharpen 1.

The mechanism is visible in the per-photo spread, which is how it was found:
the three worst frames were all landscape and the seven best were all
portrait. Orientation decides how much reduction Wix still has left to do. At
a 1920×1080 hero a landscape photo is barely reduced further (1.2×), so our
sharpening survives into the final render stacked on theirs; a portrait photo
gets reduced about 1.8× more, which washes the double-sharpening out.

Turning sharpening on at 3840px costs, at a hero:

| Orientation | Mean points lost | Range      |
| ----------- | ---------------- | ---------- |
| Landscape   | 14.3             | 3.3 – 24.3 |
| Portrait    | 5.8              | 0.2 – 13.7 |

Quality made almost no difference to the effect, which is what ruled out
compression artifacts as the cause.

The control is still exposed in the Advanced panel and as `--sharpen` on the
CLI, because this conclusion depends on Wix sharpening for us.

---

## Finding 3: the size/quality curve

12 photos, sharpening off, JPEG 4:4:4. `cost` is SSIMULACRA2 points against
what Wix already delivers from the untouched original.

| Long edge | Quality | Upload      | Of source | Hero     | In-content |
| --------- | ------- | ----------- | --------- | -------- | ---------- |
| 1600      | 72      | 180 KB      | 4.1%      | −42.0    | −18.4      |
| 1600      | 80      | 237 KB      | 5.4%      | −38.0    | −15.4      |
| 1600      | 88      | 339 KB      | 7.7%      | −36.0    | −13.5      |
| 2560      | 72      | 404 KB      | 9.2%      | −23.0    | −9.5       |
| **2560**  | **80**  | **548 KB**  | **12.4%** | −19.9    | **−7.9**   |
| 2560      | 88      | 820 KB      | 18.6%     | −18.0    | −6.9       |
| 3840      | 72      | 887 KB      | 20.1%     | −9.7     | −2.1       |
| **3840**  | **80**  | **1.20 MB** | **28.0%** | **−7.3** | −1.3       |
| 3840      | 88      | 1.83 MB     | 42.5%     | −5.6     | −0.8       |

**Quality is not the lever.** Across the whole table, q72 → q88 moves quality
by about 2 points while roughly doubling the file. q80 is the knee: q88 buys
1.9 points at the hero for 49% more bytes, q72 saves 26% for 2.4 points.

**Resolution is the lever.** 2560 → 3840 is worth 12.6 points at the hero.

**Read each preset in the context it is for.** The 1600px numbers look awful
because the table only evaluates hero and in-content; that preset is for grid
thumbnails, which are outside the band the Wix model is reliable in (see the
limitation above), so no thumbnail figure is quoted rather than quoting one
that cannot be trusted.

### What the numbers mean in absolute terms

Wix's own re-encode scores **76.7** at a hero and **76.5** in-content against a
lossless render — that is the starting point, and it is the dominant cost. The
presets then land at:

|                                   | Absolute SSIMULACRA2 |                             |
| --------------------------------- | -------------------- | --------------------------- |
| Perfect render                    | 100                  | unreachable, no compression |
| **Wix today, from your original** | **76.6**             | high quality                |
| Standard 2560px, in-content       | 68.6                 | high quality                |
| Hero 3840px, at a hero            | 69.4                 | high quality                |
| Hero 3840px, in-content           | 75.2                 | high quality                |

Nothing here reached the benchmark's own "free" bar of −1.0, and that bar is
strict on purpose: a second encode generation is not free, and the report says
so rather than rounding it away. Set against a 3.6–8× cut in storage, and
against the 23 points Wix already takes before we start, a further 1.3–7.9 is
the trade being made. Side by side at 1:1 in the app's comparison view, the
two Wix renders are not distinguishable — but the measurement is the honest
number, not that impression.

---

## What this means for the presets

| Preset              | Long edge  | Quality | For                       | Expected size      |
| ------------------- | ---------- | ------- | ------------------------- | ------------------ |
| Hero / full-bleed   | 3840px     | 80      | Full-width banners        | ~28% of source     |
| **Standard**        | **2560px** | **80**  | Blog, content, galleries  | **~12% of source** |
| Gallery / thumbnail | 1600px     | 80      | Grid thumbnails and cards | ~5% of source      |

All JPEG, MozJPEG, progressive, 4:4:4 chroma, sRGB, no metadata, no sharpening.

4:4:4 is worth the bytes here specifically _because_ Wix re-encodes: chroma
resolution discarded on upload cannot be recovered by their encoder. That is
the opposite of the usual advice for a file served directly.

Applied to the source folder that prompted this — 1,036 files, 8.05 GB:

| Preset              | Projected    | Saving   |
| ------------------- | ------------ | -------- |
| Hero 3840px         | ~2.25 GB     | 3.6×     |
| **Standard 2560px** | **~1.00 GB** | **8.1×** |
| Gallery 1600px      | ~435 MB      | 18.5×    |

Measured on a 12-file, 51.7 MB subset via the CLI at Standard: **6.4 MB, 87.6%
smaller, 6.4 seconds.**

---

## Things that did not go the way the literature suggests

- **Sharpen after downscaling.** Correct in general, wrong here, and the
  single largest effect measured. See Finding 2.
- **Prefer AVIF or WebP.** Correct when you control delivery. On Wix it is
  strictly worse than JPEG.
- **4:2:0 chroma is free on photographs.** Generally true, but it throws away
  colour resolution that Wix's re-encode cannot rebuild.
- **AVIF pass-through.** A community report claims Wix serves uploaded AVIF
  untouched. Not reproduced here, and it would need a real upload to a real
  site to settle. If it is true, an AVIF upload would skip the re-encode
  entirely and change the recommendation — worth testing directly before
  relying on it.

---

## Sources

- [`@wix/image-kit`](https://www.npmjs.com/package/@wix/image-kit) — the constants in
  `imageServiceConstants.js`, `imageTransformOptions.js` and `engines/transforms.js`
- [Wix: URL Image Transformation](https://dev.wix.com/docs/api-reference/assets/media/media-manager/url-image-transformation)
- [Wix: Optimizing your media](https://support.wix.com/en/article/site-performance-optimizing-your-media) — their own ≥2560×1440 guidance
- [Wix: Supported media file types and sizes](https://support.wix.com/en/article/wix-media-supported-media-file-types-and-file-sizes) — the 50 MB upload limit
- [Wix Studio forum: _Worse Image Compression PROOF_](https://forum.wixstudio.com/t/worse-image-compression-proof-need-disable-compression-option/64928) — users reproducing the double-compression effect
- [cloudinary/ssimulacra2](https://github.com/cloudinary/ssimulacra2) — the metric and its calibration points
- [Jon Sneyers: _Contemplating Codec Comparisons_](https://cloudinary.com/blog/contemplating-codec-comparisons) — why codec wins shrink at web-relevant bitrates
- [Malte Ubl: _AVIF and WebP quality settings_](https://www.industrialempathy.com/posts/avif-webp-quality-settings/) — cross-codec quality mapping
- [libvips `sharpen`](https://www.libvips.org/API/8.17/method.Image.sharpen.html) — the transfer curve reimplemented in `src/lib/unsharp.ts`
