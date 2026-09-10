import { describe, expect, it } from "vitest";
import { PixelBudget } from "@/lib/budget";

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
};

const tick = () => new Promise(r => setTimeout(r, 0));

describe("PixelBudget", () => {
  it("runs small tasks in parallel up to the concurrency cap", async () => {
    const budget = new PixelBudget(120, 4);
    const gates = [defer(), defer(), defer(), defer(), defer()];
    gates.forEach(g => void budget.run(2, () => g.promise));
    await tick();
    expect(budget.inFlight).toBe(4);
    expect(budget.pending).toBe(1);
    gates[0]!.resolve();
    await tick();
    expect(budget.inFlight).toBe(4);
    gates.forEach(g => g.resolve());
  });

  it("admits fewer large tasks than small ones for the same budget", async () => {
    const budget = new PixelBudget(120, 8);
    const gates = [defer(), defer(), defer(), defer()];
    gates.forEach(g => void budget.run(45, () => g.promise));
    await tick();
    // 45 + 45 fits inside 120; a third would not.
    expect(budget.inFlight).toBe(2);
    expect(budget.pending).toBe(2);
    gates.forEach(g => g.resolve());
  });

  it("lets an oversized task run alone rather than deadlocking", async () => {
    const budget = new PixelBudget(120, 4);
    let ran = false;
    await budget.run(453, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("queues an oversized task behind whatever is already running", async () => {
    const budget = new PixelBudget(120, 4);
    const small = defer();
    void budget.run(2, () => small.promise);
    await tick();

    let bigStarted = false;
    const big = budget.run(453, async () => {
      bigStarted = true;
    });
    await tick();
    expect(bigStarted).toBe(false);

    small.resolve();
    await big;
    expect(bigStarted).toBe(true);
  });

  it("does not starve a large task behind a stream of small ones", async () => {
    const budget = new PixelBudget(100, 8);
    const blocker = defer();
    void budget.run(60, () => blocker.promise);
    await tick();

    const order: string[] = [];
    const big = budget.run(60, async () => void order.push("big"));
    const small = budget.run(1, async () => void order.push("small"));
    await tick();

    blocker.resolve();
    await Promise.all([big, small]);
    expect(order[0]).toBe("big");
  });

  it("releases the budget when a task throws", async () => {
    const budget = new PixelBudget(120, 2);
    await expect(
      budget.run(50, async () => {
        throw new Error("decode failed");
      })
    ).rejects.toThrow("decode failed");
    expect(budget.inFlight).toBe(0);
    await expect(budget.run(50, async () => "ok")).resolves.toBe("ok");
  });

  it("returns the task's value", async () => {
    const budget = new PixelBudget(120, 2);
    await expect(budget.run(1, async () => 42)).resolves.toBe(42);
  });
});
