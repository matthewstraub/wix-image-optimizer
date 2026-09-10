import { useEffect, useRef, useState, type WheelEvent } from "react";
import { bytes, dimensions } from "../lib/format";
import { blobReader, probe } from "../lib/probe";
import type { EncodeSettings } from "../lib/presets";
import { RENDER_CONTEXTS } from "../lib/wix-emulate";
import type { EncodePool } from "../workers/pool";
import type { Item } from "../types";

interface Props {
  item: Item;
  settings: EncodeSettings;
  pool: EncodePool;
  onClose: () => void;
}

interface Pane {
  key: string;
  title: string;
  note: string;
  url: string | null;
  caption: string;
}

/**
 * Four panes, because the obvious comparison is the wrong one.
 *
 * The top row is the pair you have on disk. The bottom row is what Wix
 * actually delivers from each of them — and that is the only pair a visitor
 * can ever tell apart, because Wix re-encodes both. If the bottom two match,
 * the storage saving costs nothing.
 */
export default function ComparisonView({
  item,
  settings,
  pool,
  onClose,
}: Props) {
  const [panes, setPanes] = useState<Pane[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [context, setContext] = useState<(typeof RENDER_CONTEXTS)[number]>(
    RENDER_CONTEXTS[0]
  );
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    const track = (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      created.push(url);
      return url;
    };

    (async () => {
      setPanes(null);
      setError(null);
      try {
        if (!item.meta) throw new Error("Image could not be read");

        const optimisedBlob = item.result
          ? new Blob([item.result.bytes], {
              type: `image/${item.result.format}`,
            })
          : null;

        const [wixOriginal, wixOptimised] = await Promise.all([
          pool.wixPreview(item.file, item.meta, context.css),
          (async () => {
            if (!optimisedBlob) return null;
            const meta = await probe(blobReader(optimisedBlob));
            if (!meta) return null;
            return pool.wixPreview(optimisedBlob, meta, context.css);
          })(),
        ]);
        if (cancelled) return;

        const next: Pane[] = [
          {
            key: "original",
            title: "Original",
            note: "as you have it",
            url: track(item.file),
            caption: `${dimensions(item.meta.width, item.meta.height)} · ${bytes(item.file.size)}`,
          },
          {
            key: "optimised",
            title: "Optimized upload",
            note: `${settings.maxLongEdge}px q${settings.quality}`,
            url: optimisedBlob ? track(optimisedBlob) : null,
            caption: item.result
              ? `${dimensions(item.result.width, item.result.height)} · ${bytes(item.result.bytes.byteLength)}`
              : "Run Optimize to see this",
          },
          {
            key: "wix-original",
            title: "Wix serves this today",
            note: "from the original",
            url: track(
              new Blob([wixOriginal.bytes], { type: wixOriginal.mime })
            ),
            caption: `${dimensions(wixOriginal.delivery.rendered.width, wixOriginal.delivery.rendered.height)} · ${bytes(wixOriginal.bytes.byteLength)} ${wixOriginal.delivery.format.toUpperCase()}`,
          },
          {
            key: "wix-optimised",
            title: "Wix would serve this",
            note: "from the optimized upload",
            url: wixOptimised
              ? track(
                  new Blob([wixOptimised.bytes], { type: wixOptimised.mime })
                )
              : null,
            caption: wixOptimised
              ? `${dimensions(wixOptimised.delivery.rendered.width, wixOptimised.delivery.rendered.height)} · ${bytes(wixOptimised.bytes.byteLength)} ${wixOptimised.delivery.format.toUpperCase()}`
              : "Run Optimize to see this",
          },
        ];
        urls.current = created;
        setPanes(next);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
      urls.current = [];
    };
  }, [item, context, pool, settings.maxLongEdge, settings.quality]);

  const onWheel = (event: WheelEvent) => {
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView(v => ({
      ...v,
      scale: Math.min(12, Math.max(1, v.scale * factor)),
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white p-4 dark:bg-neutral-950">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{item.relativePath}</h2>
          <p className="text-xs text-neutral-500">
            The bottom row is the only pair a visitor could tell apart — Wix
            re-encodes both.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={context.id}
            onChange={e =>
              setContext(
                RENDER_CONTEXTS.find(c => c.id === e.target.value) ??
                  RENDER_CONTEXTS[0]
              )
            }
            className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            {RENDER_CONTEXTS.map(c => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.css.width}×{c.css.height})
              </option>
            ))}
          </select>
          <span className="tnum text-xs text-neutral-500">
            {(view.scale * 100).toFixed(0)}%
          </span>
          <button
            type="button"
            onClick={() => setView({ scale: 1, x: 0, y: 0 })}
            className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={() => setView(v => ({ ...v, scale: 4 }))}
            className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700"
          >
            Zoom 4×
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-neutral-900 px-3 py-1 font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Close
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!panes && !error && (
        <p className="text-sm text-neutral-500">
          Rendering what Wix would serve…
        </p>
      )}

      {panes && (
        <div
          className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2"
          onWheel={onWheel}
          onPointerDown={e =>
            (dragging.current = { x: e.clientX, y: e.clientY })
          }
          onPointerMove={e => {
            if (!dragging.current) return;
            const dx = e.clientX - dragging.current.x;
            const dy = e.clientY - dragging.current.y;
            dragging.current = { x: e.clientX, y: e.clientY };
            setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
          }}
          onPointerUp={() => (dragging.current = null)}
          onPointerLeave={() => (dragging.current = null)}
        >
          {panes.map(pane => (
            <figure
              key={pane.key}
              className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800"
            >
              <figcaption className="flex items-baseline justify-between gap-2 border-b border-neutral-100 px-3 py-1.5 text-xs dark:border-neutral-900">
                <span className="font-medium">
                  {pane.title}{" "}
                  <span className="font-normal text-neutral-500">
                    {pane.note}
                  </span>
                </span>
                <span className="tnum text-neutral-500">{pane.caption}</span>
              </figcaption>
              <div className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-neutral-100 dark:bg-neutral-900">
                {pane.url ? (
                  <img
                    src={pane.url}
                    alt={pane.title}
                    draggable={false}
                    className="max-h-full max-w-full select-none object-contain"
                    style={{
                      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                      // Show the actual pixels once zoomed past 1:1 rather
                      // than the browser's smoothing of them.
                      imageRendering: view.scale >= 3 ? "pixelated" : "auto",
                    }}
                  />
                ) : (
                  <p className="p-6 text-center text-xs text-neutral-500">
                    {pane.caption}
                  </p>
                )}
              </div>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
