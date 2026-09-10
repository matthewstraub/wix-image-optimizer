/**
 * Output presets and the hard limits around them.
 *
 * The numbers here come from Wix's own delivery pipeline, not from general web
 * advice — see RESEARCH.md. The short version: Wix re-encodes every image on
 * delivery, so the saving comes from uploading fewer pixels, not from
 * compressing harder. Compressing harder just feeds their encoder a damaged
 * source.
 */

export type OutputFormat = "jpeg" | "webp" | "avif" | "png";
export type ChromaSubsampling = "4:4:4" | "4:2:0";

export interface EncodeSettings {
  format: OutputFormat;
  /** 1-100. Ignored for `png`, which is always lossless here. */
  quality: number;
  chroma: ChromaSubsampling;
  /** Longest side of the output, in pixels. Never upscales. */
  maxLongEdge: number;
  /**
   * Unsharp mask strength, as a multiplier on the default amount.
   * 0 disables it; 1 is the calibrated default for a ~3x downscale.
   */
  sharpen: number;
}

export interface Preset {
  id: PresetId;
  label: string;
  blurb: string;
  settings: EncodeSettings;
}

export type PresetId = "hero" | "standard" | "gallery";

/**
 * Wix clamps its own transforms here (MAX_TRANSFORMED_IMAGE_WIDTH /
 * SAFE_TRANSFORMED_AREA in @wix/image-kit), so uploading beyond it is storage
 * you can never serve.
 */
export const WIX_MAX_LONG_EDGE = 5000;
export const WIX_MAX_AREA = 25_000_000;

/** Wix rejects uploads above this outright. */
export const WIX_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const JPEG_DEFAULTS = {
  format: "jpeg",
  // Provisional until bench/run.ts lands; see RESEARCH.md for the final call.
  quality: 90,
  // 4:4:4 matters here specifically because Wix re-encodes: chroma resolution
  // thrown away on upload cannot be recovered by their encoder.
  chroma: "4:4:4",
  sharpen: 1,
} as const satisfies Omit<EncodeSettings, "maxLongEdge">;

export const PRESETS: readonly Preset[] = [
  {
    id: "hero",
    label: "Hero / full-bleed",
    blurb: "Full-width banners. True 2x for a 1920px-wide desktop hero.",
    settings: { ...JPEG_DEFAULTS, maxLongEdge: 3840 },
  },
  {
    id: "standard",
    label: "Standard",
    blurb:
      "Blog, content and most galleries. Matches Wix's own stated minimum.",
    settings: { ...JPEG_DEFAULTS, maxLongEdge: 2560 },
  },
  {
    id: "gallery",
    label: "Gallery / thumbnail",
    blurb: "Grid thumbnails and cards.",
    settings: { ...JPEG_DEFAULTS, maxLongEdge: 1600 },
  },
];

export const DEFAULT_PRESET_ID: PresetId = "standard";

export function getPreset(id: PresetId): Preset {
  const found = PRESETS.find(p => p.id === id);
  if (!found) throw new Error(`Unknown preset: ${id}`);
  return found;
}

/**
 * Fit `source` inside a `maxLongEdge` box, preserving aspect ratio.
 * Never upscales: an image already smaller than the target is left alone.
 */
export function targetDimensions(
  source: { width: number; height: number },
  maxLongEdge: number
): { width: number; height: number } {
  const longEdge = Math.max(source.width, source.height);
  if (longEdge <= maxLongEdge) {
    return { width: source.width, height: source.height };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/** Clamp user-supplied Advanced settings into the range Wix can actually use. */
export function clampSettings(settings: EncodeSettings): EncodeSettings {
  return {
    ...settings,
    quality: Math.min(100, Math.max(1, Math.round(settings.quality))),
    maxLongEdge: Math.min(
      WIX_MAX_LONG_EDGE,
      Math.max(16, Math.round(settings.maxLongEdge))
    ),
    sharpen: Math.min(3, Math.max(0, settings.sharpen)),
  };
}

export const EXTENSION_FOR_FORMAT: Record<OutputFormat, string> = {
  jpeg: "jpg",
  webp: "webp",
  avif: "avif",
  png: "png",
};
