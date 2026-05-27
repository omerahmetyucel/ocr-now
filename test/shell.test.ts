import { describe, expect, test } from "bun:test";
import { PromiseQueue, run, runPool } from "../src/shell";

describe("run", () => {
  test("missing binary throws a 'not found on PATH' error", async () => {
    await expect(run(["this-binary-definitely-does-not-exist-xyz"])).rejects.toThrow(/not found on PATH/);
  });
});

describe("runPool", () => {
  test("preserves input order even when completions are out of order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runPool(items, 3, async n => {
      // larger n completes sooner → reverse completion order
      await new Promise(r => setTimeout(r, (6 - n) * 5));
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });
  test("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    await runPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return 0;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });
  test("empty input returns empty array", async () => {
    expect(await runPool([], 4, async () => 0)).toEqual([]);
  });
  test("more workers than items still works", async () => {
    expect(await runPool([1, 2], 10, async n => n)).toEqual([1, 2]);
  });
  test("worker function receives index", async () => {
    expect(await runPool(["a", "b", "c"], 2, async (_, i) => i)).toEqual([0, 1, 2]);
  });
});

describe("PromiseQueue", () => {
  test("push then take resolves with the pushed item", async () => {
    const q = new PromiseQueue<number>();
    q.push(42);
    expect(await q.take()).toBe(42);
  });
  test("take blocks until push", async () => {
    const q = new PromiseQueue<string>();
    let resolved = false;
    const p = q.take().then(v => {
      resolved = true;
      return v;
    });
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);
    q.push("hi");
    expect(await p).toBe("hi");
  });
  test("close before take returns undefined", async () => {
    const q = new PromiseQueue<number>();
    q.close();
    expect(await q.take()).toBeUndefined();
  });
  test("close wakes pending takers with undefined", async () => {
    const q = new PromiseQueue<number>();
    const p1 = q.take();
    const p2 = q.take();
    q.close();
    expect(await p1).toBeUndefined();
    expect(await p2).toBeUndefined();
  });
  test("multi-producer multi-consumer drains correctly", async () => {
    const q = new PromiseQueue<number>();
    const received: number[] = [];
    const consumers = Array.from({ length: 3 }, async () => {
      while (true) {
        const x = await q.take();
        if (x === undefined) break;
        received.push(x);
      }
    });
    for (let i = 0; i < 10; i++) q.push(i);
    q.close();
    await Promise.all(consumers);
    expect(received.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
