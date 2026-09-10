import { useMemo, useState } from "react";
import { bytes, dimensions, percentSaved } from "../lib/format";
import { outputRelativePath } from "../lib/filename";
import type { Item } from "../types";

interface Props {
  items: Item[];
  suffix: string;
  outputExt: string;
  onSelect: (id: string) => void;
}

/** Group by source folder so the output tree is visible before it is written. */
function group(items: Item[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const cut = item.relativePath.lastIndexOf("/");
    const folder = cut < 0 ? "" : item.relativePath.slice(0, cut);
    let bucket = groups.get(folder);
    if (!bucket) groups.set(folder, (bucket = []));
    bucket.push(item);
  }
  return groups;
}

export default function FileTable({
  items,
  suffix,
  outputExt,
  onSelect,
}: Props) {
  const groups = useMemo(() => group(items), [items]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (folder: string) =>
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  return (
    <div className="space-y-3">
      {[...groups].map(([folder, groupItems]) => {
        const isCollapsed = collapsed.has(folder);
        const done = groupItems.filter(i => i.result);
        return (
          <section
            key={folder || "/"}
            className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800"
          >
            <button
              type="button"
              onClick={() => toggle(folder)}
              className="flex w-full items-center justify-between gap-3 bg-neutral-50 px-3 py-2 text-left text-sm dark:bg-neutral-900"
            >
              <span className="font-medium">
                {folder || "(top level)"}
                <span className="ml-2 font-normal text-neutral-500">
                  {groupItems.length} file{groupItems.length === 1 ? "" : "s"}
                </span>
              </span>
              <span className="tnum text-xs text-neutral-500">
                {done.length > 0 &&
                  `${bytes(done.reduce((n, i) => n + i.file.size, 0))} → ${bytes(
                    done.reduce((n, i) => n + i.result!.bytes.byteLength, 0)
                  )}`}
                <span className="ml-2">{isCollapsed ? "▸" : "▾"}</span>
              </span>
            </button>

            {!isCollapsed && (
              <table className="w-full text-sm">
                <tbody>
                  {groupItems.map(item => (
                    <Row
                      key={item.id}
                      item={item}
                      suffix={suffix}
                      outputExt={outputExt}
                      onSelect={onSelect}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Row({
  item,
  suffix,
  outputExt,
  onSelect,
}: {
  item: Item;
  suffix: string;
  outputExt: string;
  onSelect: (id: string) => void;
}) {
  const name = item.relativePath.split("/").pop() ?? item.relativePath;
  const outName =
    outputRelativePath(item.relativePath, {
      suffix,
      ext: item.result?.ext ?? outputExt,
    })
      .split("/")
      .pop() ?? "";

  return (
    <tr className="border-t border-neutral-100 dark:border-neutral-900">
      <td className="max-w-0 px-3 py-2">
        <button
          type="button"
          onClick={() => onSelect(item.id)}
          disabled={!item.meta}
          className="block w-full truncate text-left hover:underline disabled:no-underline"
          title={item.relativePath}
        >
          {name}
        </button>
        <div className="truncate text-xs text-neutral-500" title={outName}>
          {outName}
        </div>
      </td>
      <td className="tnum whitespace-nowrap px-3 py-2 text-right text-xs text-neutral-500">
        {item.meta && dimensions(item.meta.width, item.meta.height)}
      </td>
      <td className="tnum whitespace-nowrap px-3 py-2 text-right">
        {bytes(item.file.size)}
      </td>
      <td className="tnum whitespace-nowrap px-3 py-2 text-right">
        {item.result ? (
          <>
            <span className="text-green-700 dark:text-green-400">
              {bytes(item.result.bytes.byteLength)}
            </span>
            <span className="ml-2 text-xs text-neutral-500">
              −{percentSaved(item.file.size, item.result.bytes.byteLength)}
            </span>
          </>
        ) : (
          <Status item={item} />
        )}
      </td>
    </tr>
  );
}

function Status({ item }: { item: Item }) {
  const tone =
    item.status === "error"
      ? "text-red-600 dark:text-red-400"
      : item.status === "skipped"
        ? "text-amber-600 dark:text-amber-400"
        : "text-neutral-500";
  const label =
    item.status === "working"
      ? "working…"
      : item.status === "queued"
        ? "queued"
        : item.status;
  return (
    <span className={`text-xs ${tone}`} title={item.message}>
      {label}
      {item.message && (
        <span className="ml-2 hidden text-neutral-500 sm:inline">
          {item.message}
        </span>
      )}
    </span>
  );
}
