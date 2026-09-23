import { loadConfig } from "./config";
import { run } from "./shell";
import { AUTO, HARDCODED_DEFAULT_LANG } from "./util";

// Installed languages don't change mid-run; --lang=auto spawns this several
// times per file, so cache the result across the process.
let installedLangsCache: Promise<string[]> | null = null;

async function fetchInstalledLangs(): Promise<string[]> {
  const res = await run(["tesseract", "--list-langs"]);
  if (res.exitCode !== 0) {
    throw new Error(`tesseract --list-langs failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return (res.stdout + "\n" + res.stderr)
    .split("\n")
    .map(s => s.trim())
    .filter(s => s && /^[a-zA-Z0-9_]+$/.test(s) && s !== "List");
}

export async function listInstalledLangs(): Promise<string[]> {
  if (!installedLangsCache) installedLangsCache = fetchInstalledLangs();
  return installedLangsCache;
}

export async function validateLang(lang: string): Promise<string> {
  const parts = lang.split("+").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`empty language value`);
  const installed = new Set(await listInstalledLangs());
  const missing = parts.filter(p => !installed.has(p));
  if (missing.length > 0) {
    const list = [...installed].sort().join(", ") || "(none)";
    throw new Error(
      `language "${missing.join(", ")}" is not installed.\n` +
      `       installed: ${list}\n` +
      `       to add more: brew install tesseract-lang  (or drop a .traineddata file into your tessdata dir)\n` +
      `       tesseract uses ISO 639-2/T codes (e.g. eng, tur, deu, fra). Combine with '+': --lang=tur+eng`
    );
  }
  return parts.join("+");
}

export async function resolveLang(override: string | undefined): Promise<string> {
  const lang = (override?.trim()) || (await loadConfig()).defaultLang || HARDCODED_DEFAULT_LANG;
  if (lang === AUTO) return AUTO; // validated at detection time
  await validateLang(lang);
  return lang;
}

export async function pickAutoBaseline(): Promise<string> {
  const installed = await listInstalledLangs();
  if (installed.length === 0) throw new Error(`no tesseract languages installed`);
  const installedSet = new Set(installed);
  // Prefer the user's configured language as the sample-pass model:
  // it produces clean diacritics for their typical docs, and still passes
  // through ASCII-clean text in other Latin-script languages well enough
  // for franc to detect.
  const cfg = await loadConfig();
  if (cfg.defaultLang && cfg.defaultLang !== AUTO) {
    const parts = cfg.defaultLang.split("+").map(p => p.trim()).filter(Boolean);
    if (parts.length > 0 && parts.every(p => installedSet.has(p))) {
      return cfg.defaultLang;
    }
  }
  if (installedSet.has("eng")) return "eng";
  return installed.sort()[0];
}
