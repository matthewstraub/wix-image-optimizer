/** Messages exchanged with encode.worker.ts. */

import type { EncodeSettings, OutputFormat } from "../lib/presets";
import type { ProbeResult } from "../lib/probe";
import type { Size, WixDelivery } from "../lib/wix-emulate";

export interface OptimiseJob {
  id: number;
  kind: "optimise";
  blob: Blob;
  meta: ProbeResult;
  settings: EncodeSettings;
}

export interface WixPreviewJob {
  id: number;
  kind: "wix";
  blob: Blob;
  meta: ProbeResult;
  css: Size;
  wire?: "avif" | "webp";
}

export type WorkerJob = OptimiseJob | WixPreviewJob;

export interface OptimiseDone {
  id: number;
  ok: true;
  kind: "optimise";
  bytes: ArrayBuffer;
  format: OutputFormat;
  ext: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  keptAlpha: boolean;
}

export interface WixPreviewDone {
  id: number;
  ok: true;
  kind: "wix";
  bytes: ArrayBuffer;
  mime: string;
  delivery: WixDelivery;
  raster: Size;
}

export interface JobFailed {
  id: number;
  ok: false;
  message: string;
}

export type WorkerResponse = OptimiseDone | WixPreviewDone | JobFailed;
