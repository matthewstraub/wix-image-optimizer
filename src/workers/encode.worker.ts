/// <reference lib="webworker" />
/**
 * One image at a time, off the main thread.
 *
 * Each worker is single-threaded on purpose. Parallelism comes from running
 * several workers rather than from threading inside one, which keeps us clear
 * of SharedArrayBuffer and therefore of having to serve COOP/COEP headers —
 * a real simplification for a static site.
 */

import { optimise } from "../lib/pipeline";
import { renderWixPreview } from "../lib/wix-browser";
import type { WorkerJob, WorkerResponse } from "./protocol";

async function handle(job: WorkerJob): Promise<WorkerResponse> {
  if (job.kind === "optimise") {
    const result = await optimise(job.blob, job.meta, job.settings);
    return {
      id: job.id,
      ok: true,
      kind: "optimise",
      bytes: result.bytes.buffer as ArrayBuffer,
      format: result.format,
      ext: result.ext,
      width: result.width,
      height: result.height,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      keptAlpha: result.keptAlpha,
    };
  }

  const preview = await renderWixPreview({
    blob: job.blob,
    meta: job.meta,
    css: job.css,
    ...(job.wire ? { wire: job.wire } : {}),
  });
  return {
    id: job.id,
    ok: true,
    kind: "wix",
    bytes: await preview.blob.arrayBuffer(),
    mime: preview.blob.type,
    delivery: preview.delivery,
    raster: preview.raster,
  };
}

self.onmessage = async (event: MessageEvent<WorkerJob>) => {
  try {
    const response = await handle(event.data);
    // Transfer rather than copy; nothing here touches the bytes again.
    const transfer = response.ok ? [response.bytes] : [];
    self.postMessage(response, transfer);
  } catch (error) {
    const response: WorkerResponse = {
      id: event.data.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
