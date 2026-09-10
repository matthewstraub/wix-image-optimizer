import { bytes, duration, percentSaved } from "../lib/format";
import type { EncodeSettings } from "../lib/presets";

interface Totals {
  files: number;
  done: number;
  skipped: number;
  failed: number;
  sourceBytes: number;
  doneSourceBytes: number;
  outputBytes: number;
  oversized: number;
}

interface Props {
  totals: Totals;
  settings: EncodeSettings;
  running: boolean;
  elapsed: number | null;
  canDownload: boolean;
  supportsFolder: boolean;
  zipWarning: boolean;
  onOptimise: () => void;
  onCancel: () => void;
  onSaveFolder: () => void;
  onSaveZip: () => void;
  onClear: () => void;
}

export default function TotalsBar({
  totals,
  settings,
  running,
  elapsed,
  canDownload,
  supportsFolder,
  zipWarning,
  onOptimise,
  onCancel,
  onSaveFolder,
  onSaveZip,
  onClear,
}: Props) {
  const complete = totals.done > 0;
  return (
    <div className="sticky top-0 z-10 rounded-lg border border-neutral-200 bg-white/90 p-4 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="tnum text-sm">
          <span className="font-medium">{totals.files} files</span>
          <span className="mx-2 text-neutral-400">·</span>
          <span>{bytes(totals.sourceBytes)}</span>
          {complete && (
            <>
              <span className="mx-2 text-neutral-400">→</span>
              <span className="font-medium text-green-700 dark:text-green-400">
                {bytes(totals.outputBytes)}
              </span>
              <span className="mx-2 text-neutral-400">·</span>
              <span>
                {percentSaved(totals.doneSourceBytes, totals.outputBytes)}{" "}
                smaller
              </span>
              {totals.done < totals.files && (
                <span className="ml-2 text-neutral-500">
                  ({totals.done} of {totals.files} done)
                </span>
              )}
            </>
          )}
          {elapsed !== null && !running && (
            <span className="ml-2 text-neutral-500">
              in {duration(elapsed)}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {running ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onOptimise}
              disabled={totals.files === totals.done + totals.skipped}
              // A flat opacity knock-down leaves blue-on-near-black unreadable,
              // so the disabled state gets its own colours rather than a
              // faded version of the enabled ones.
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white enabled:hover:bg-blue-500 disabled:bg-neutral-200 disabled:text-neutral-500 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
            >
              Optimize {settings.maxLongEdge}px q{settings.quality}
            </button>
          )}
          {supportsFolder && (
            <button
              type="button"
              onClick={onSaveFolder}
              disabled={!canDownload || running}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              Save to folder
            </button>
          )}
          <button
            type="button"
            onClick={onSaveZip}
            disabled={!canDownload || running}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 dark:border-neutral-700"
          >
            Download ZIP
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={running}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-40 dark:text-neutral-400"
          >
            Clear
          </button>
        </div>
      </div>

      {(totals.skipped > 0 ||
        totals.failed > 0 ||
        totals.oversized > 0 ||
        (zipWarning && canDownload)) && (
        <ul className="mt-3 space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          {totals.skipped > 0 && (
            <li>
              {totals.skipped} too large for a browser tab — run{" "}
              <code>npm run optimize</code> on those.
            </li>
          )}
          {totals.failed > 0 && <li>{totals.failed} failed. See the list.</li>}
          {totals.oversized > 0 && (
            <li>
              {totals.oversized} original
              {totals.oversized === 1 ? " is" : "s are"} over Wix's 50 MB upload
              limit and would be rejected as-is.
            </li>
          )}
          {zipWarning && canDownload && (
            <li>
              This ZIP is over 2 GB and has to be built in memory.{" "}
              {supportsFolder
                ? "Saving to a folder streams straight to disk instead."
                : "Consider optimizing in smaller batches."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
