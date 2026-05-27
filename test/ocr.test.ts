import { describe, expect, test } from "bun:test";
import { parsePages, planRasterTasks, validatePageRanges } from "../src/ocr";

describe("parsePages", () => {
  test("single page", () => {
    expect(parsePages("1")).toEqual([[1, 1]]);
  });
  test("simple range", () => {
    expect(parsePages("1-3")).toEqual([[1, 3]]);
  });
  test("non-contiguous", () => {
    expect(parsePages("1-3,7")).toEqual([[1, 3], [7, 7]]);
  });
  test("merges adjacent ranges", () => {
    expect(parsePages("1-3,4-6")).toEqual([[1, 6]]);
  });
  test("merges overlapping ranges", () => {
    expect(parsePages("1-5,3-7")).toEqual([[1, 7]]);
  });
  test("sorts unsorted input", () => {
    expect(parsePages("7,1-3")).toEqual([[1, 3], [7, 7]]);
  });
  test("tolerates whitespace", () => {
    expect(parsePages(" 1 , 3-5 ")).toEqual([[1, 1], [3, 5]]);
  });
  test("rejects invalid syntax", () => {
    expect(() => parsePages("abc")).toThrow(/invalid/);
    expect(() => parsePages("1-")).toThrow(/invalid/);
  });
  test("rejects end < start", () => {
    expect(() => parsePages("5-3")).toThrow(/end < start/);
  });
  test("rejects zero or negative", () => {
    expect(() => parsePages("0")).toThrow(/>= 1/);
  });
  test("rejects empty input", () => {
    expect(() => parsePages("")).toThrow(/requires a value/);
    expect(() => parsePages(",,")).toThrow(/requires a value/);
  });
});

describe("validatePageRanges", () => {
  test("in-bounds ranges pass", () => {
    expect(() => validatePageRanges([[1, 3], [5, 5]], 10)).not.toThrow();
  });
  test("range matching last page passes", () => {
    expect(() => validatePageRanges([[1, 10]], 10)).not.toThrow();
  });
  test("upper bound exceeds total", () => {
    expect(() => validatePageRanges([[1, 11]], 10)).toThrow(/out of bounds.*10 pages/);
  });
  test("single page beyond total", () => {
    expect(() => validatePageRanges([[15, 15]], 10)).toThrow(/range 15.*out of bounds/);
  });
  test("singular pluralization", () => {
    expect(() => validatePageRanges([[2, 2]], 1)).toThrow(/1 page\)/);
  });
  test("empty ranges pass trivially", () => {
    expect(() => validatePageRanges([], 10)).not.toThrow();
  });
});

describe("planRasterTasks", () => {
  test("more workers than pages → one task per page", () => {
    expect(planRasterTasks([[1, 3]], 6)).toEqual([[1, 1], [2, 2], [3, 3]]);
  });
  test("fewer workers than pages → chunked", () => {
    // total=10, ceil(10/4)=3 → [1-3, 4-6, 7-9, 10-10]
    expect(planRasterTasks([[1, 10]], 4)).toEqual([[1, 3], [4, 6], [7, 9], [10, 10]]);
  });
  test("multi-range never crosses a boundary", () => {
    expect(planRasterTasks([[1, 3], [10, 12]], 6)).toEqual([
      [1, 1], [2, 2], [3, 3], [10, 10], [11, 11], [12, 12],
    ]);
  });
  test("empty input → no tasks", () => {
    expect(planRasterTasks([], 6)).toEqual([]);
  });
  test("single-page range", () => {
    expect(planRasterTasks([[5, 5]], 6)).toEqual([[5, 5]]);
  });
});
