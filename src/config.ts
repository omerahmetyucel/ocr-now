import { readFile, writeFile } from "node:fs/promises";
import { CONFIG_PATH, DPI_MAX, DPI_MIN, HARDCODED_DEFAULT_DPI } from "./util";

export type Config = {
  defaultLang?: string;
  defaultDpi?: number;
  autoMinConfidence?: number;
  autoMinSampleChars?: number;
};

export const VALID_CONFIG_KEYS = [
  "defaultLang",
  "defaultDpi",
  "autoMinConfidence",
  "autoMinSampleChars",
] as const;
export type ConfigKey = (typeof VALID_CONFIG_KEYS)[number];

export function isValidKey(k: string): k is ConfigKey {
  return (VALID_CONFIG_KEYS as readonly string[]).includes(k);
}

export async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function validateDpi(value: string | number): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`dpi must be an integer`);
  if (n < DPI_MIN || n > DPI_MAX) throw new Error(`dpi must be between ${DPI_MIN} and ${DPI_MAX}`);
  return n;
}

export function validateConfidence(value: string | number): number {
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) throw new Error(`autoMinConfidence must be a number`);
  if (n < 0 || n > 1) throw new Error(`autoMinConfidence must be between 0 and 1`);
  return n;
}

export function validateSampleChars(value: string | number): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`autoMinSampleChars must be an integer`);
  if (n < 1) throw new Error(`autoMinSampleChars must be >= 1`);
  return n;
}

export async function resolveDpi(override: string | undefined): Promise<number> {
  if (override !== undefined && override !== "") return validateDpi(override);
  const cfg = await loadConfig();
  return cfg.defaultDpi ?? HARDCODED_DEFAULT_DPI;
}
