/**
 * Writing results back out, preserving the input folder tree.
 *
 * Two paths, and the choice matters for a batch this size. The File System
 * Access API streams each file straight to disk as it finishes, so 8 GB of
 * photos never exists in memory at once. A ZIP has to be assembled before the
 * browser will save it, which is the single most likely way to kill the tab
 * on a large job — so it is the fallback, for Safari and Firefox.
 */

import { downloadZip } from "client-zip";

export interface OutputFile {
  /** Path relative to the output root, with forward slashes. */
  path: string;
  bytes: ArrayBuffer;
  lastModified?: Date;
}

export function supportsDirectoryOutput(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
    id?: string;
  }) => Promise<FileSystemDirectoryHandle>;
};

/** Returns null when the browser cannot, or the user cancels. */
export async function pickOutputDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ mode: "readwrite", id: "wix-image-optimizer" });
  } catch {
    // AbortError when the user dismisses the dialog; nothing to report.
    return null;
  }
}

/**
 * Write one file into `root`, creating intermediate folders as needed.
 * Directory handles are cached because a batch writes hundreds of files into
 * the same handful of folders.
 */
export async function writeInto(
  root: FileSystemDirectoryHandle,
  file: OutputFile,
  cache = new Map<string, Promise<FileSystemDirectoryHandle>>()
): Promise<void> {
  const segments = file.path.split("/");
  const name = segments.pop();
  if (!name) throw new Error(`Not a file path: ${file.path}`);

  let directory = root;
  let key = "";
  for (const segment of segments) {
    key = key ? `${key}/${segment}` : segment;
    let pending = cache.get(key);
    if (!pending) {
      pending = directory.getDirectoryHandle(segment, { create: true });
      cache.set(key, pending);
    }
    directory = await pending;
  }

  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file.bytes);
  await writable.close();
}

/**
 * Assemble a ZIP and hand it to the browser. Entry names carry the relative
 * path, which is what preserves the tree.
 */
export async function downloadAsZip(
  files: OutputFile[],
  filename = "optimized.zip"
): Promise<void> {
  const blob = await downloadZip(
    files.map(file => ({
      name: file.path,
      lastModified: file.lastModified ?? new Date(),
      input: file.bytes,
    }))
  ).blob();

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Roughly where a ZIP stops being a good idea. Everything is already
 * compressed, so the archive is about the sum of its parts and all of it has
 * to be held at once.
 */
export const ZIP_WARNING_BYTES = 2 * 1024 * 1024 * 1024;
