import { describe, expect, test } from "bun:test";
import { CONCURRENCY, FRANC_TO_TESS, classify, fmtBytes, pageNumOf } from "../src/util";

describe("classify", () => {
  test("pdf", () => {
    expect(classify("foo.pdf")).toBe("pdf");
    expect(classify("/a/b/c.PDF")).toBe("pdf");
  });
  test("supported image extensions", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif"]) {
      expect(classify(`x${ext}`)).toBe("img");
    }
  });
  test("ext is case-insensitive", () => {
    expect(classify("PIC.JPG")).toBe("img");
  });
  test("unsupported or extensionless", () => {
    expect(classify("foo.txt")).toBeNull();
    expect(classify("foo")).toBeNull();
    expect(classify("")).toBeNull();
  });
});

describe("fmtBytes", () => {
  test("bytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });
  test("kilobytes", () => {
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
  });
  test("megabytes", () => {
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("pageNumOf", () => {
  test("matches pdftoppm output", () => {
    expect(pageNumOf("page-1.png")).toBe(1);
    expect(pageNumOf("page-42.png")).toBe(42);
    expect(pageNumOf("page-100.png")).toBe(100);
  });
  test("no match returns 0", () => {
    expect(pageNumOf("foo.png")).toBe(0);
    expect(pageNumOf("page-1.txt")).toBe(0);
    expect(pageNumOf("")).toBe(0);
  });
});

test("CONCURRENCY is within [1, 6]", () => {
  expect(CONCURRENCY).toBeGreaterThanOrEqual(1);
  expect(CONCURRENCY).toBeLessThanOrEqual(6);
});

test("FRANC_TO_TESS covers chinese variants", () => {
  expect(FRANC_TO_TESS.cmn).toBe("chi_sim");
  expect(FRANC_TO_TESS.yue).toBe("chi_tra");
  expect(FRANC_TO_TESS.zho).toBe("chi_sim");
});
