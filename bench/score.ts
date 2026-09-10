/**
 * Perceptual quality metrics.
 *
 * SSIMULACRA2 is the primary number because it has a published calibration —
 * 90 is visually lossless in a flicker test at 1:1, 70 is high quality with
 * artifacts perceptible but not annoying, 50 is medium. That gives the
 * benchmark an absolute threshold to aim at rather than a relative ranking.
 * DSSIM comes along as a cross-check from an independent implementation.
 *
 * The Python SSIMULACRA2 build pays about a second of numpy/scipy import on
 * startup, which would dominate a sweep of several hundred comparisons, so it
 * runs as one long-lived process fed over stdin.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const execFileAsync = promisify(execFile);

/** Lower is more similar; Kornel's guidance treats <0.0025 as high fidelity. */
export async function dssim(
  referencePng: string,
  candidatePng: string
): Promise<number> {
  const { stdout } = await execFileAsync("dssim", [referencePng, candidatePng]);
  const value = Number(stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(value)) {
    throw new Error(`Could not parse dssim output: ${stdout}`);
  }
  return value;
}

const WORKER_SOURCE = `
import sys, json
from ssimulacra2 import compute_ssimulacra2
sys.stderr.write("ready\\n"); sys.stderr.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        a, b = json.loads(line)
        print(json.dumps({"score": compute_ssimulacra2(a, b)}), flush=True)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
`;

/**
 * A persistent scorer. Call `close()` when the sweep is done, or the process
 * keeps the event loop alive.
 */
export class Ssimulacra2 {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiting: Array<{
    resolve: (n: number) => void;
    reject: (e: Error) => void;
  }> = [];

  constructor() {
    this.child = spawn("python3", ["-c", WORKER_SOURCE], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.onData(chunk));
    this.child.on("exit", code => {
      const error = new Error(`ssimulacra2 worker exited with code ${code}`);
      while (this.waiting.length) this.waiting.shift()!.reject(error);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const pending = this.waiting.shift();
      if (!pending) continue;
      try {
        const parsed = JSON.parse(line) as { score?: number; error?: string };
        if (parsed.error !== undefined) pending.reject(new Error(parsed.error));
        else pending.resolve(parsed.score!);
      } catch {
        pending.reject(new Error(`Unparseable scorer output: ${line}`));
      }
    }
  }

  /** Higher is better. 90 = visually lossless, 70 = high, 50 = medium. */
  score(referencePng: string, candidatePng: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify([referencePng, candidatePng])}\n`
      );
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/**
 * SSIMULACRA2 thresholds, from the reference implementation's README. Used to
 * turn a score into a verdict in the report.
 */
export function verdict(score: number): string {
  if (score >= 90) return "visually lossless";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  if (score >= 30) return "low";
  return "very low";
}

/**
 * A pool of scorers. One process is a bottleneck for a sweep of several
 * hundred comparisons, and each is single-threaded, so the wall clock scales
 * almost linearly with the pool size until memory runs out.
 */
export class Ssimulacra2Pool {
  private readonly workers: Ssimulacra2[];
  private next = 0;
  private readonly busy: Promise<unknown>[];

  constructor(size: number) {
    this.workers = Array.from({ length: size }, () => new Ssimulacra2());
    this.busy = Array.from({ length: size }, () => Promise.resolve());
  }

  /** Round-robin, chaining onto each worker's queue so none is oversubscribed. */
  score(referencePng: string, candidatePng: string): Promise<number> {
    const slot = this.next++ % this.workers.length;
    const result = this.busy[slot]!.then(() =>
      this.workers[slot]!.score(referencePng, candidatePng)
    );
    // Keep the chain alive even if one comparison fails.
    this.busy[slot] = result.catch(() => undefined);
    return result;
  }

  close(): void {
    for (const worker of this.workers) worker.close();
  }
}
