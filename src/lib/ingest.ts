/**
 * Turn a drop or a folder picker into files that remember where they came
 * from, so the output can mirror the input tree.
 *
 * Three sources, because no single API covers every browser:
 *   - `<input webkitdirectory>` gives `webkitRelativePath` for free
 *   - a drop exposes `getAsFileSystemHandle()` on Chrome and Edge
 *   - everything else falls back to the older `webkitGetAsEntry()` walk
 */

export interface IngestedFile {
  file: File;
  /** Path relative to the dropped root, using forward slashes. */
  relativePath: string;
}

const SUPPORTED = /\.(jpe?g|jpe|jfif|png|heic|heif|tiff?|webp|avif|gif|bmp)$/i;

const isSupported = (name: string) =>
  SUPPORTED.test(name) && !name.startsWith(".");

/** From `<input type="file" webkitdirectory multiple>` or a plain multiple. */
export function fromFileList(files: FileList | File[]): IngestedFile[] {
  return Array.from(files)
    .filter(file => isSupported(file.name))
    .map(file => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
}

/** From a drop. Handles folders, nested arbitrarily deep. */
export async function fromDataTransfer(
  transfer: DataTransfer
): Promise<IngestedFile[]> {
  const items = Array.from(transfer.items).filter(i => i.kind === "file");
  if (items.length === 0) return fromFileList(transfer.files);

  // Read every handle or entry up front. Both go stale once we await, because
  // the DataTransfer is only valid for the duration of the event.
  const roots = items.map(item => ({
    handle: getHandle(item),
    entry: item.webkitGetAsEntry?.() ?? null,
    file: item.getAsFile(),
  }));

  const out: IngestedFile[] = [];
  for (const root of roots) {
    const handle = await root.handle;
    if (handle) {
      await walkHandle(handle, "", out);
      continue;
    }
    if (root.entry) {
      await walkEntry(root.entry, "", out);
      continue;
    }
    if (root.file && isSupported(root.file.name)) {
      out.push({ file: root.file, relativePath: root.file.name });
    }
  }
  return out;
}

type HandleCapableItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
};

function getHandle(item: DataTransferItem): Promise<FileSystemHandle | null> {
  const capable = item as HandleCapableItem;
  if (typeof capable.getAsFileSystemHandle !== "function") {
    return Promise.resolve(null);
  }
  return capable.getAsFileSystemHandle().catch(() => null);
}

const join = (prefix: string, name: string) =>
  prefix ? `${prefix}/${name}` : name;

async function walkHandle(
  handle: FileSystemHandle,
  prefix: string,
  out: IngestedFile[]
): Promise<void> {
  if (handle.kind === "file") {
    const file = await (handle as FileSystemFileHandle).getFile();
    if (isSupported(file.name)) {
      out.push({ file, relativePath: join(prefix, file.name) });
    }
    return;
  }
  const directory = handle as FileSystemDirectoryHandle;
  if (directory.name.startsWith(".")) return;
  const next = join(prefix, directory.name);
  for await (const child of directory.values()) {
    await walkHandle(child, next, out);
  }
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: IngestedFile[]
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>(resolve =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    );
    if (file && isSupported(file.name)) {
      out.push({ file, relativePath: join(prefix, file.name) });
    }
    return;
  }
  if (!entry.isDirectory || entry.name.startsWith(".")) return;

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const next = join(prefix, entry.name);
  // readEntries hands back at most 100 entries per call and signals the end
  // with an empty batch. Calling it once silently truncates any folder larger
  // than that — which is every folder this tool exists for.
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) break;
    for (const child of batch) await walkEntry(child, next, out);
  }
}

function readBatch(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  return new Promise(resolve =>
    reader.readEntries(
      entries => resolve(entries),
      () => resolve([])
    )
  );
}

/** From `showDirectoryPicker()`, where the browser supports it. */
export async function fromDirectoryHandle(
  handle: FileSystemDirectoryHandle
): Promise<IngestedFile[]> {
  const out: IngestedFile[] = [];
  for await (const child of handle.values()) {
    await walkHandle(child, "", out);
  }
  return out;
}

/** Distinct folders in a batch, in first-seen order, for grouping the UI. */
export function foldersOf(files: IngestedFile[]): string[] {
  const seen = new Set<string>();
  for (const { relativePath } of files) {
    const cut = relativePath.lastIndexOf("/");
    seen.add(cut < 0 ? "" : relativePath.slice(0, cut));
  }
  return [...seen];
}
