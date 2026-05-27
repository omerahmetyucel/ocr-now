import { describe, expect, test } from "bun:test";
import {
  pagesToRanges, parsePages, parsePdfimagesOutput,
  planRasterTasks, renderPages, validatePageRanges,
} from "../src/ocr";

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

describe("pagesToRanges", () => {
  test("empty input", () => {
    expect(pagesToRanges([])).toEqual([]);
  });
  test("single page", () => {
    expect(pagesToRanges([5])).toEqual([[5, 5]]);
  });
  test("contiguous block", () => {
    expect(pagesToRanges([1, 2, 3])).toEqual([[1, 3]]);
  });
  test("non-contiguous singletons", () => {
    expect(pagesToRanges([1, 3, 5])).toEqual([[1, 1], [3, 3], [5, 5]]);
  });
  test("mixed contiguous and singleton", () => {
    expect(pagesToRanges([1, 2, 5, 6, 7, 10])).toEqual([[1, 2], [5, 7], [10, 10]]);
  });
  test("unsorted input is sorted", () => {
    expect(pagesToRanges([5, 1, 2, 3])).toEqual([[1, 3], [5, 5]]);
  });
  test("duplicates are deduped", () => {
    expect(pagesToRanges([1, 1, 2, 2])).toEqual([[1, 2]]);
  });
});

describe("parsePdfimagesOutput", () => {
  const header = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n" +
    "--------------------------------------------------------------------------------------------\n";
  test("empty output → empty set", () => {
    expect(parsePdfimagesOutput("")).toEqual(new Set());
  });
  test("header only → empty set", () => {
    expect(parsePdfimagesOutput(header)).toEqual(new Set());
  });
  test("single image on page 1", () => {
    const out = header + "   1     0 image    640   480  rgb     3   8  jpeg   no       12  0   72   72  100K  10%\n";
    expect(parsePdfimagesOutput(out)).toEqual(new Set([1]));
  });
  test("multiple images on same page deduped", () => {
    const out = header +
      "   3     0 image    640   480  rgb     3   8  jpeg   no       12  0   72   72  100K  10%\n" +
      "   3     1 image    100   100  rgb     3   8  jpeg   no       15  0   72   72   10K   5%\n";
    expect(parsePdfimagesOutput(out)).toEqual(new Set([3]));
  });
  test("multiple pages with images", () => {
    const out = header +
      "   1     0 image    640   480  rgb     3   8  jpeg   no       12  0   72   72  100K  10%\n" +
      "   3     0 image    800   600  rgb     3   8  jpeg   no       20  0   72   72  150K  12%\n" +
      "  16     0 image   1200   900  rgb     3   8  jpeg   no       42  0   72   72  300K  15%\n";
    expect(parsePdfimagesOutput(out)).toEqual(new Set([1, 3, 16]));
  });
});

describe("renderPages", () => {
  test("renders pages in numeric order with headers", () => {
    const out = renderPages([
      { num: 2, text: "second" },
      { num: 1, text: "first" },
    ]);
    expect(out).toBe("--- Page 1 ---\nfirst\n\n--- Page 2 ---\nsecond");
  });
  test("trims page text", () => {
    expect(renderPages([{ num: 1, text: "  hello  \n\n" }])).toBe("--- Page 1 ---\nhello");
  });
  test("empty input → empty string", () => {
    expect(renderPages([])).toBe("");
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
