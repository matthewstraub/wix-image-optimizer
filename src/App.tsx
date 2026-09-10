import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DropZone from "./components/DropZone";
import Controls from "./components/Controls";
import TotalsBar from "./components/TotalsBar";
import FileTable from "./components/FileTable";
import ComparisonView from "./components/ComparisonView";
import WhyJpeg from "./components/WhyJpeg";
import { EncodePool } from "./workers/pool";
import { blobReader, probe } from "./lib/probe";
import { BROWSER_MAX_MEGAPIXELS } from "./lib/budget";
import {
  clampSettings,
  DEFAULT_PRESET_ID,
  EXTENSION_FOR_FORMAT,
  getPreset,
  WIX_MAX_UPLOAD_BYTES,
  type EncodeSettings,
  type PresetId,
} from "./lib/presets";
import { outputRelativePath, uniquePath } from "./lib/filename";
import type { IngestedFile } from "./lib/ingest";
import {
  downloadAsZip,
  pickOutputDirectory,
  supportsDirectoryOutput,
  writeInto,
  ZIP_WARNING_BYTES,
} from "./lib/output";
import type { Item } from "./types";

const SETTINGS_KEY = "wix-image-optimizer:settings";

interface StoredSettings {
  presetId: PresetId;
  suffix: string;
  overrides: Partial<EncodeSettings>;
}

function loadSettings(): StoredSettings {
  const fallback: StoredSettings = {
    presetId: DEFAULT_PRESET_ID,
    suffix: "optimized",
    overrides: {},
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw
      ? { ...fallback, ...(JSON.parse(raw) as StoredSettings) }
      : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [stored, setStored] = useState<StoredSettings>(loadSettings);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const poolRef = useRef<EncodePool | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
  }, [stored]);

  useEffect(() => () => poolRef.current?.terminate(), []);

  const settings = useMemo(
    () =>
      clampSettings({
        ...getPreset(stored.presetId).settings,
        ...stored.overrides,
      }),
    [stored]
  );

  const pool = () => (poolRef.current ??= new EncodePool());

  const addFiles = useCallback(async (incoming: IngestedFile[]) => {
    if (incoming.length === 0) return;
    const probed = await Promise.all(
      incoming.map(async ({ file, relativePath }): Promise<Item> => {
        const base = {
          id: `${relativePath}:${file.size}:${file.lastModified}`,
          file,
          relativePath,
        };
        const meta = await probe(blobReader(file));
        if (!meta) {
          return {
            ...base,
            status: "error",
            message: "Not a readable image",
          };
        }
        if (meta.megapixels > BROWSER_MAX_MEGAPIXELS) {
          return {
            ...base,
            meta,
            status: "skipped",
            message:
              `${meta.megapixels.toFixed(0)} MP is too large to decode in a ` +
              `browser tab. Use the command line tool for this one.`,
          };
        }
        return { ...base, meta, status: "queued" };
      })
    );

    setItems(previous => {
      const seen = new Set(previous.map(i => i.id));
      return [...previous, ...probed.filter(i => !seen.has(i.id))];
    });
  }, []);

  const patch = useCallback((id: string, next: Partial<Item>) => {
    setItems(previous =>
      previous.map(item => (item.id === id ? { ...item, ...next } : item))
    );
  }, []);

  const optimiseAll = useCallback(async () => {
    const pending = items.filter(
      i => i.status === "queued" || i.status === "error"
    );
    if (pending.length === 0) return;

    cancelRef.current = false;
    setRunning(true);
    setElapsed(null);
    const started = performance.now();

    await Promise.all(
      pending.map(async item => {
        if (!item.meta) return;
        if (cancelRef.current) return;
        patch(item.id, { status: "working", message: undefined });
        try {
          const result = await pool().optimise(item.file, item.meta, settings);
          if (cancelRef.current) return;
          patch(item.id, { status: "done", result });
        } catch (error) {
          patch(item.id, {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    setRunning(false);
    setElapsed(performance.now() - started);
  }, [items, patch, settings]);

  /**
   * Changing an encode setting invalidates every result, so they are dropped
   * back to queued. Done here rather than in an effect watching `settings`:
   * this is a response to an event, and an effect would also fire on the
   * initial mount and on changes that do not affect output, like the suffix.
   */
  const changeSettings = useCallback(
    (next: {
      presetId?: PresetId;
      suffix?: string;
      overrides?: Partial<EncodeSettings>;
    }) => {
      setStored(previous => ({ ...previous, ...next }));
      if (next.presetId === undefined && next.overrides === undefined) return;
      setItems(previous =>
        previous.map(item =>
          item.status === "done"
            ? { ...item, status: "queued", result: undefined }
            : item
        )
      );
    },
    []
  );

  const cancel = () => {
    cancelRef.current = true;
    poolRef.current?.terminate();
    poolRef.current = null;
    setRunning(false);
    setItems(previous =>
      previous.map(i =>
        i.status === "working" ? { ...i, status: "queued" } : i
      )
    );
  };

  const outputs = useMemo(() => {
    const taken = new Set<string>();
    return items
      .filter(item => item.status === "done" && item.result)
      .map(item => ({
        item,
        path: uniquePath(
          outputRelativePath(item.relativePath, {
            suffix: stored.suffix,
            ext: item.result!.ext,
          }),
          taken
        ),
      }));
  }, [items, stored.suffix]);

  const totals = useMemo(() => {
    const done = items.filter(i => i.status === "done" && i.result);
    return {
      files: items.length,
      done: done.length,
      skipped: items.filter(i => i.status === "skipped").length,
      failed: items.filter(i => i.status === "error").length,
      sourceBytes: items.reduce((n, i) => n + i.file.size, 0),
      doneSourceBytes: done.reduce((n, i) => n + i.file.size, 0),
      outputBytes: done.reduce((n, i) => n + i.result!.bytes.byteLength, 0),
      oversized: items.filter(i => i.file.size > WIX_MAX_UPLOAD_BYTES).length,
    };
  }, [items]);

  const saveToFolder = async () => {
    const root = await pickOutputDirectory();
    if (!root) return;
    const cache = new Map<string, Promise<FileSystemDirectoryHandle>>();
    for (const { item, path } of outputs) {
      await writeInto(
        root,
        {
          path,
          bytes: item.result!.bytes,
          lastModified: new Date(item.file.lastModified),
        },
        cache
      );
    }
  };

  const saveAsZip = () =>
    downloadAsZip(
      outputs.map(({ item, path }) => ({
        path,
        bytes: item.result!.bytes,
        lastModified: new Date(item.file.lastModified),
      }))
    );

  const chosen = items.find(i => i.id === selected) ?? null;

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Wix Image Optimizer
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          Shrink photos before uploading them to Wix. Everything runs in this
          tab — no file is ever sent anywhere.
        </p>
      </header>

      <DropZone onFiles={addFiles} busy={running} />

      <Controls
        presetId={stored.presetId}
        suffix={stored.suffix}
        overrides={stored.overrides}
        settings={settings}
        disabled={running}
        onChange={changeSettings}
      />

      {items.length > 0 && (
        <>
          <TotalsBar
            totals={totals}
            settings={settings}
            running={running}
            elapsed={elapsed}
            canDownload={outputs.length > 0}
            supportsFolder={supportsDirectoryOutput()}
            zipWarning={totals.outputBytes > ZIP_WARNING_BYTES}
            onOptimise={optimiseAll}
            onCancel={cancel}
            onSaveFolder={saveToFolder}
            onSaveZip={saveAsZip}
            onClear={() => {
              setItems([]);
              setElapsed(null);
              setSelected(null);
            }}
          />
          <FileTable
            items={items}
            suffix={stored.suffix}
            outputExt={EXTENSION_FOR_FORMAT[settings.format]}
            onSelect={setSelected}
          />
        </>
      )}

      <WhyJpeg />

      {chosen && (
        <ComparisonView
          item={chosen}
          settings={settings}
          pool={pool()}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
