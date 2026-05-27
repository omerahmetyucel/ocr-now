import { describe, expect, test } from "bun:test";
import { run, runPool } from "../src/shell";

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
