import { useRef, useState, type DragEvent } from "react";
import {
  fromDataTransfer,
  fromFileList,
  type IngestedFile,
} from "../lib/ingest";

interface Props {
  onFiles: (files: IngestedFile[]) => void;
  busy: boolean;
}

export default function DropZone({ onFiles, busy }: Props) {
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    setReading(true);
    try {
      onFiles(await fromDataTransfer(event.dataTransfer));
    } finally {
      setReading(false);
    }
  };

  return (
    <div
      onDragOver={e => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
        over
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
          : "border-neutral-300 dark:border-neutral-700"
      }`}
    >
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        {reading
          ? "Reading folder…"
          : "Drop a folder of photos here. Subfolders are kept."}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => folderInput.current?.click()}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          Choose folder
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
        >
          Choose files
        </button>
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        JPEG, PNG, HEIC and TIFF. Nothing leaves your machine.
      </p>

      <input
        ref={folderInput}
        type="file"
        multiple
        // Not in the React types, but every browser that matters supports it.
        {...{ webkitdirectory: "" }}
        className="hidden"
        onChange={e => {
          if (e.target.files) onFiles(fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/*,.heic,.heif,.tif,.tiff"
        className="hidden"
        onChange={e => {
          if (e.target.files) onFiles(fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}
