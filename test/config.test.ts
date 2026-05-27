import { describe, expect, test } from "bun:test";
import { VALID_CONFIG_KEYS, isValidKey, validateDpi } from "../src/config";

describe("isValidKey", () => {
  test("valid keys", () => {
    expect(isValidKey("defaultLang")).toBe(true);
    expect(isValidKey("defaultDpi")).toBe(true);
  });
  test("invalid or wrong-case keys", () => {
    expect(isValidKey("foo")).toBe(false);
    expect(isValidKey("")).toBe(false);
    expect(isValidKey("defaultlang")).toBe(false);
  });
});

describe("validateDpi", () => {
  test("valid integer strings", () => {
    expect(validateDpi("300")).toBe(300);
    expect(validateDpi("72")).toBe(72);
    expect(validateDpi("600")).toBe(600);
  });
  test("valid numbers", () => {
    expect(validateDpi(400)).toBe(400);
  });
  test("below DPI_MIN", () => {
    expect(() => validateDpi("71")).toThrow(/between 72 and 600/);
  });
  test("above DPI_MAX", () => {
    expect(() => validateDpi("601")).toThrow(/between 72 and 600/);
  });
  test("non-numeric input", () => {
    expect(() => validateDpi("abc")).toThrow(/integer/);
  });
  test("decimal number rejected", () => {
    expect(() => validateDpi(300.5)).toThrow(/integer/);
  });
});

test("VALID_CONFIG_KEYS matches expected set", () => {
  expect([...VALID_CONFIG_KEYS]).toEqual(["defaultLang", "defaultDpi"]);
});
