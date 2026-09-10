import type { ProbeResult } from "./lib/probe";
import type { OptimiseResult } from "./workers/pool";

export type ItemStatus = "queued" | "working" | "done" | "error" | "skipped";

export interface Item {
  /** Stable across re-drops of the same file. */
  id: string;
  file: File;
  relativePath: string;
  // Explicit `| undefined` because exactOptionalPropertyTypes is on and these
  // get cleared back to undefined when settings change.
  meta?: ProbeResult | undefined;
  status: ItemStatus;
  message?: string | undefined;
  result?: OptimiseResult | undefined;
}
