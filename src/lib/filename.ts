/**
 * Output naming.
 *
 * Wix puts the filename straight into the image URL, so the file part gets
 * slugified. Directory names are preserved verbatim — they are not part of any
 * URL, and the point of mirroring a folder tree is that you can still recognise
 * it afterwards.
 */

const FALLBACK_STEM = "image";

/** Split "a/b/c.jpg" into its directory segments and its filename. */
export function splitPath(relativePath: string): {
  dirs: string[];
  file: string;
} {
  const segments = relativePath
    .split(/[/\\]+/)
    .map(s => s.trim())
    // Drop empties, "." and any ".." that would climb out of the output root.
    .filter(s => s.length > 0 && s !== "." && s !== "..");
  const file = segments.pop() ?? "";
  return { dirs: segments, file };
}

/** "photo.final.JPG" -> { stem: "photo.final", ext: "JPG" } */
export function splitExtension(file: string): { stem: string; ext: string } {
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return { stem: file, ext: "" };
  return { stem: file.slice(0, dot), ext: file.slice(dot + 1) };
}

/**
 * Lowercase, hyphen-separated, URL-safe. Inserts a break at camelCase
 * boundaries so "SkyMatt" reads as "sky-matt", but never splits runs of digits
 * or runs of capitals — truncating those would risk two source files
 * collapsing onto one name.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : FALLBACK_STEM;
}

/**
 * Strip characters that are illegal or awkward in a path segment, without
 * otherwise rewriting the name.
 */
export function sanitizeDirName(name: string): string {
  const cleaned = name
    // The control-character range is the point: these are illegal in a path
    // segment on every filesystem, and a folder name arriving from a drop is
    // not something we control.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "folder";
}

export interface NameOptions {
  /** Appended to the stem, e.g. "-optimized". Empty string keeps the stem. */
  suffix: string;
  /** Extension without the dot, e.g. "jpg". */
  ext: string;
}

export function outputFileName(file: string, opts: NameOptions): string {
  const { stem } = splitExtension(file);
  const suffix = opts.suffix ? slugify(opts.suffix) : "";
  const slug = slugify(stem);
  const withSuffix = suffix ? `${slug}-${suffix}` : slug;
  return `${withSuffix}.${opts.ext}`;
}

/** Map an input relative path onto its output relative path. */
export function outputRelativePath(
  relativePath: string,
  opts: NameOptions
): string {
  const { dirs, file } = splitPath(relativePath);
  const outDirs = dirs.map(sanitizeDirName);
  return [...outDirs, outputFileName(file, opts)].join("/");
}

/**
 * Guarantee uniqueness within a run. Two different source names can slugify to
 * the same output ("IMG_0001.jpg" and "img 0001.jpg"), and silently
 * overwriting one with the other would lose a photo.
 *
 * Mutates `taken`, which should be shared across a whole batch.
 */
export function uniquePath(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  const dot = candidate.lastIndexOf(".");
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const ext = dot > 0 ? candidate.slice(dot) : "";
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
}
