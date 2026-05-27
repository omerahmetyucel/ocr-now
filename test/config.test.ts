import { describe, expect, test } from "bun:test";
import {
  VALID_CONFIG_KEYS, isValidKey,
  validateConfidence, validateDpi, validateSampleChars,
} from "../src/config";

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

describe("validateConfidence", () => {
  test("valid decimal", () => {
    expect(validateConfidence("0.2")).toBe(0.2);
    expect(validateConfidence(0.5)).toBe(0.5);
  });
  test("boundary values", () => {
    expect(validateConfidence("0")).toBe(0);
    expect(validateConfidence("1")).toBe(1);
  });
  test("below 0", () => {
    expect(() => validateConfidence("-0.1")).toThrow(/between 0 and 1/);
  });
  test("above 1", () => {
    expect(() => validateConfidence("1.5")).toThrow(/between 0 and 1/);
  });
  test("non-numeric", () => {
    expect(() => validateConfidence("abc")).toThrow(/must be a number/);
  });
});

describe("validateSampleChars", () => {
  test("valid positive integer", () => {
    expect(validateSampleChars("20")).toBe(20);
    expect(validateSampleChars(50)).toBe(50);
  });
  test("below 1", () => {
    expect(() => validateSampleChars("0")).toThrow(/>= 1/);
  });
  test("decimal rejected", () => {
    expect(() => validateSampleChars(20.5)).toThrow(/integer/);
  });
  test("non-numeric", () => {
    expect(() => validateSampleChars("abc")).toThrow(/integer/);
  });
});

test("VALID_CONFIG_KEYS matches expected set", () => {
  expect([...VALID_CONFIG_KEYS]).toEqual([
    "defaultLang",
    "defaultDpi",
    "autoMinConfidence",
    "autoMinSampleChars",
  ]);
});
