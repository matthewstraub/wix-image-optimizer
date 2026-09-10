/**
 * Admission control by megapixels rather than by task count.
 *
 * Counting tasks is the obvious thing and the wrong thing here. Eight workers
 * each holding a decoded 45 MP frame is about 1.4 GB of RGBA, which kills a
 * browser tab; eight workers each holding a 2 MP phone snap is nothing. What
 * has to be bounded is total pixels in flight, so a batch of small files runs
 * wide and a batch of drone frames runs narrow, with no configuration.
 */

interface Waiter {
  pixels: number;
  resolve: () => void;
}

export class PixelBudget {
  private available: number;
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    /** Total megapixels allowed in flight at once. */
    private readonly capacity: number,
    /** Hard ceiling on parallel tasks, whatever their size. */
    private readonly maxConcurrent: number
  ) {
    this.available = capacity;
  }

  get inFlight(): number {
    return this.running;
  }

  get pending(): number {
    return this.queue.length;
  }

  /**
   * Wait for room, then run `task`. A single item larger than the whole
   * budget is allowed to run on its own rather than deadlocking — refusing it
   * here would just move the failure somewhere less clear.
   */
  async run<T>(megapixels: number, task: () => Promise<T>): Promise<T> {
    const cost = Math.min(Math.max(megapixels, 0), this.capacity);
    await this.acquire(cost);
    try {
      return await task();
    } finally {
      this.release(cost);
    }
  }

  private acquire(pixels: number): Promise<void> {
    // Strict FIFO. Letting a late small task overtake a queued large one is
    // how a 45 MP frame ends up waiting behind an unbounded stream of phone
    // snaps and never runs at all.
    if (this.queue.length === 0 && this.canAdmit(pixels)) {
      this.take(pixels);
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.queue.push({ pixels, resolve });
    });
  }

  private canAdmit(pixels: number): boolean {
    if (this.running >= this.maxConcurrent) return false;
    // Nothing running means this item is the whole batch's worth; let it go
    // even if it is bigger than the budget.
    if (this.running === 0) return true;
    return pixels <= this.available;
  }

  private take(pixels: number): void {
    this.available -= pixels;
    this.running++;
  }

  private release(pixels: number): void {
    this.available += pixels;
    this.running--;
    // Strictly in order, so a large frame behind a run of small ones cannot be
    // starved indefinitely.
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (!this.canAdmit(next.pixels)) break;
      this.queue.shift();
      this.take(next.pixels);
      next.resolve();
    }
  }
}

/**
 * Browser defaults. 120 MP of RGBA is roughly 480 MB, which leaves room for
 * the encoder's own working set on a laptop without pushing the tab over.
 */
export const BROWSER_PIXEL_BUDGET_MP = 120;

/**
 * Above this a browser tab is not a safe place to decode. PNG is what sets it:
 * unlike JPEG it has no reduced-scale decode, so the full RGBA buffer has to
 * exist before anything can be resized.
 */
export const BROWSER_MAX_MEGAPIXELS = 100;

/** Below this a full-resolution decode is cheap enough not to bother staging. */
export const FULL_DECODE_MAX_MEGAPIXELS = 40;
