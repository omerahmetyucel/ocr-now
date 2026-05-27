import { describe, expect, test } from "bun:test";
import { flagStr, looksLikePath, parseArgs, suggestCommand } from "../src/args";

describe("parseArgs", () => {
  test("empty argv", () => {
    expect(parseArgs([])).toEqual({ flags: {}, positional: [] });
  });
  test("positional only", () => {
    expect(parseArgs(["start"])).toEqual({ flags: {}, positional: ["start"] });
  });
  test("boolean --flag", () => {
    expect(parseArgs(["--copy"])).toEqual({ flags: { copy: true }, positional: [] });
  });
  test("--key=value", () => {
    expect(parseArgs(["--lang=tur"])).toEqual({ flags: { lang: "tur" }, positional: [] });
  });
  test("value may contain =", () => {
    expect(parseArgs(["--out=a=b"])).toEqual({ flags: { out: "a=b" }, positional: [] });
  });
  test("short flags -h / -v", () => {
    expect(parseArgs(["-h"])).toEqual({ flags: { help: true }, positional: [] });
    expect(parseArgs(["-v"])).toEqual({ flags: { version: true }, positional: [] });
  });
  test("mixed flags + positional", () => {
    expect(parseArgs(["start", "--lang=eng", "--dpi=400", "--copy"])).toEqual({
      flags: { lang: "eng", dpi: "400", copy: true },
      positional: ["start"],
    });
  });
  test("unknown short flag falls into positional", () => {
    expect(parseArgs(["-x"])).toEqual({ flags: {}, positional: ["-x"] });
  });
});

describe("flagStr", () => {
  test("string passes through", () => {
    expect(flagStr("eng")).toBe("eng");
  });
  test("boolean → undefined", () => {
    expect(flagStr(true)).toBeUndefined();
  });
  test("undefined → undefined", () => {
    expect(flagStr(undefined)).toBeUndefined();
  });
});

describe("looksLikePath", () => {
  test("absolute path", () => {
    expect(looksLikePath("/Users/foo/bar.pdf")).toBe(true);
  });
  test("relative path", () => {
    expect(looksLikePath("./foo.pdf")).toBe(true);
  });
  test("tilde-prefixed", () => {
    expect(looksLikePath("~/Downloads/x.pdf")).toBe(true);
  });
  test("bare filename with extension", () => {
    expect(looksLikePath("invoice.pdf")).toBe(true);
  });
  test("plain command word", () => {
    expect(looksLikePath("start")).toBe(false);
    expect(looksLikePath("config")).toBe(false);
  });
});

describe("suggestCommand", () => {
  test("exact match", () => {
    expect(suggestCommand("start")).toBe("start");
  });
  test("typos within distance 2", () => {
    expect(suggestCommand("stat")).toBe("start");
    expect(suggestCommand("configg")).toBe("config");
    expect(suggestCommand("lang")).toBe("langs");
  });
  test("case-insensitive", () => {
    expect(suggestCommand("Start")).toBe("start");
  });
  test("too far → null", () => {
    expect(suggestCommand("xyzzy")).toBeNull();
  });
});
