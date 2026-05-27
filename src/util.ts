import { dirname, extname, join } from "node:path";
import { cpus } from "node:os";

export const AUTO = "auto";
export const HARDCODED_DEFAULT_LANG = "tur";
export const HARDCODED_DEFAULT_DPI = 300;
export const DPI_MIN = 72;
export const DPI_MAX = 600;
export const AUTO_DETECTION_DPI = "150";
export const AUTO_MIN_SAMPLE_CHARS = 20;
export const AUTO_MIN_CONFIDENCE = 0.2;
export const CONCURRENCY = Math.max(1, Math.min(6, cpus().length));

export const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif",
]);

// ISO 639-3 (franc) → Tesseract code, only for entries that aren't identity.
export const FRANC_TO_TESS: Record<string, string> = {
  cmn: "chi_sim",
  yue: "chi_tra",
  zho: "chi_sim",
};

export const PROJECT_ROOT = dirname(import.meta.dir);
export const CONFIG_PATH = join(PROJECT_ROOT, "config.json");

export function classify(path: string): "pdf" | "img" | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "img";
  return null;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function pageNumOf(filename: string): number {
  const m = /-(\d+)\.png$/.exec(filename);
  return m ? parseInt(m[1], 10) : 0;
}
