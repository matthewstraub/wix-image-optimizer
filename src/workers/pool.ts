/**
 * A pool of encode workers, admitted by megapixels rather than by count.
 *
 * See budget.ts for why: eight workers each holding a decoded 45 MP frame is
 * about 1.4 GB of RGBA and kills the tab, while eight holding phone snaps is
 * nothing. Sizing the pool by CPU alone gets this wrong in both directions.
 */

import { BROWSER_PIXEL_BUDGET_MP, PixelBudget } from "../lib/budget";
import type { EncodeSettings } from "../lib/presets";
import type { ProbeResult } from "../lib/probe";
import type { Size } from "../lib/wix-emulate";
import type {
  OptimiseDone,
  WixPreviewDone,
  WorkerJob,
  WorkerResponse,
} from "./protocol";

export type OptimiseResult = Omit<OptimiseDone, "id" | "ok" | "kind">;
export type WixPreviewResult = Omit<WixPreviewDone, "id" | "ok" | "kind">;

/** Leave a core for the UI, and do not spin up more than the work needs. */
export function defaultPoolSize(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(cores - 1, 8));
}

export class EncodePool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiting: Array<(worker: Worker) => void> = [];
  private readonly budget: PixelBudget;
  private nextId = 1;

  constructor(
    private readonly size = defaultPoolSize(),
    budgetMegapixels = BROWSER_PIXEL_BUDGET_MP
  ) {
    this.budget = new PixelBudget(budgetMegapixels, this.size);
  }

  private spawn(): Worker {
    const worker = new Worker(new URL("./encode.worker.ts", import.meta.url), {
      type: "module",
    });
    this.workers.push(worker);
    return worker;
  }

  private acquire(): Promise<Worker> {
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    if (this.workers.length < this.size) return Promise.resolve(this.spawn());
    return new Promise(resolve => this.waiting.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  optimise(
    blob: Blob,
    meta: ProbeResult,
    settings: EncodeSettings
  ): Promise<OptimiseResult> {
    return this.dispatch<OptimiseResult>(meta.megapixels, id => ({
      id,
      kind: "optimise",
      blob,
      meta,
      settings,
    }));
  }

  wixPreview(
    blob: Blob,
    meta: ProbeResult,
    css: Size,
    wire?: "avif" | "webp"
  ): Promise<WixPreviewResult> {
    return this.dispatch<WixPreviewResult>(meta.megapixels, id => ({
      id,
      kind: "wix",
      blob,
      meta,
      css,
      ...(wire ? { wire } : {}),
    }));
  }

  private dispatch<T>(
    megapixels: number,
    build: (id: number) => WorkerJob
  ): Promise<T> {
    return this.budget.run(megapixels, async () => {
      const worker = await this.acquire();
      const id = this.nextId++;
      try {
        return await new Promise<T>((resolve, reject) => {
          const cleanup = () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
          };
          const onMessage = (event: MessageEvent<WorkerResponse>) => {
            if (event.data.id !== id) return;
            cleanup();
            if (event.data.ok) {
              const { id: _id, ok: _ok, kind: _kind, ...rest } = event.data;
              resolve(rest as T);
            } else {
              reject(new Error(event.data.message));
            }
          };
          const onError = (event: ErrorEvent) => {
            cleanup();
            reject(new Error(event.message || "Worker crashed"));
          };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          worker.postMessage(build(id));
        });
      } finally {
        this.release(worker);
      }
    });
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}
