#!/usr/bin/env bun
import { readdir, mkdir, writeFile, rm, mkdtemp, stat, readFile } from "node:fs/promises";
import { join, extname, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";

const HARDCODED_DEFAULT_LANG = "tur";
const DPI = "300";
const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif",
]);
const PROJECT_ROOT = dirname(import.meta.dir);
const CONFIG_PATH = join(PROJECT_ROOT, "config.json");

type RunResult = { stdout: string; stderr: string; exitCode: number };

const isTty = Boolean(process.stdout.isTTY);

function startSpinner(label: string): () => void {
  if (!isTty) {
    console.log(`       ${label}...`);
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const t0 = performance.now();
  let i = 0;
  const render = () => {
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r\x1b[2K       ${frames[i++ % frames.length]} ${label} ${dt}s`);
  };
  render();
  const id = setInterval(render, 100);
  return () => {
    clearInterval(id);
    process.stdout.write("\r\x1b[2K");
  };
}

function renderBar(done: number, total: number, t0: number) {
  if (!isTty) return;
  const width = 24;
  const filled = Math.round((done / total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = Math.round((done / total) * 100);
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\r\x1b[2K       [${bar}] ${done}/${total} (${pct}%) ${dt}s`);
}

async function run(cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function ocrImage(path: string, lang: string): Promise<string> {
  const { stdout, stderr, exitCode } = await run([
    "tesseract", path, "stdout", "-l", lang,
  ]);
  if (exitCode !== 0) throw new Error(`tesseract failed: ${stderr.trim()}`);
  return stdout;
}

async function ocrPdf(path: string, lang: string): Promise<{ text: string; pages: number }> {
  const tmp = await mkdtemp(join(tmpdir(), "ocr-now-"));
  try {
    const stopSpinner = startSpinner("rasterizing pdf");
    const tRast = performance.now();
    const { exitCode, stderr } = await run([
      "pdftoppm", "-r", DPI, "-png", path, join(tmp, "page"),
    ]);
    stopSpinner();
    if (exitCode !== 0) throw new Error(`pdftoppm failed: ${stderr.trim()}`);
    const pages = (await readdir(tmp)).filter(f => f.endsWith(".png")).sort();
    const rastDt = ((performance.now() - tRast) / 1000).toFixed(1);
    console.log(`       rasterized ${pages.length} page${pages.length === 1 ? "" : "s"} (${rastDt}s)`);

    const parts: string[] = [];
    const tOcr = performance.now();
    renderBar(0, pages.length, tOcr);
    for (let i = 0; i < pages.length; i++) {
      const text = await ocrImage(join(tmp, pages[i]), lang);
      parts.push(`--- Page ${i + 1} ---\n${text.trim()}`);
      renderBar(i + 1, pages.length, tOcr);
      if (!isTty) console.log(`         page ${i + 1}/${pages.length}`);
    }
    if (isTty) process.stdout.write("\n");
    return { text: parts.join("\n\n"), pages: pages.length };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function classify(path: string): "pdf" | "img" | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "img";
  return null;
}

async function processFile(
  path: string,
  label: string,
  lang: string,
): Promise<{ text: string; pages: number; kind: "pdf" | "img" }> {
  const kind = classify(path);
  if (!kind) throw new Error(`unsupported file type: ${path}`);
  const size = fmtBytes((await stat(path)).size);
  console.log(`ocr    ${label}  [${kind}, ${size}]`);
  const t0 = performance.now();
  let text: string;
  let pages = 1;
  if (kind === "pdf") {
    const r = await ocrPdf(path, lang);
    text = r.text;
    pages = r.pages;
  } else {
    const stopSpinner = startSpinner("ocr");
    try {
      text = await ocrImage(path, lang);
    } finally {
      stopSpinner();
    }
  }
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`done   ${label}  pages=${pages}  chars=${text.length}  took=${dt}s`);
  return { text, pages, kind };
}

async function start(lang: string) {
  const inputDir = join(PROJECT_ROOT, "input");
  const outputDir = join(PROJECT_ROOT, "output");
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const entries = (await readdir(inputDir))
    .filter(f => !f.startsWith("."))
    .sort();
  if (entries.length === 0) {
    console.error(`No files in ${inputDir}`);
    process.exit(1);
  }

  console.log(`engine tesseract  lang=${lang}  dpi=${DPI}`);
  console.log(`input  ${inputDir}  (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);

  const sections: string[] = [];
  let totalPages = 0;
  const runStart = performance.now();

  for (const name of entries) {
    const full = join(inputDir, name);
    if (!classify(full)) {
      console.log(`skip   ${name} (unsupported)`);
      continue;
    }
    const { text, pages } = await processFile(full, name, lang);
    totalPages += pages;
    sections.push(`========== ${name} ==========\n${text.trim()}\n`);
  }

  if (sections.length === 0) {
    console.error("Nothing to OCR.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(outputDir, `ocr-now ${lang.toUpperCase()} ${stamp}.txt`);
  const body = sections.join("\n");
  await writeFile(outPath, body);
  const totalDt = ((performance.now() - runStart) / 1000).toFixed(1);
  console.log(`wrote  ${outPath}  (${fmtBytes(body.length)}, ${totalPages} page${totalPages === 1 ? "" : "s"}, ${totalDt}s total)`);
}

async function single(arg: string, lang: string) {
  const path = resolve(process.cwd(), arg);
  let s;
  try {
    s = await stat(path);
  } catch {
    throw new Error(`not found: ${path}`);
  }
  if (!s.isFile()) throw new Error(`not a file: ${path}`);
  if (!classify(path)) throw new Error(`unsupported file type: ${path}`);

  console.log(`engine tesseract  lang=${lang}  dpi=${DPI}`);
  console.log(`file   ${path}`);

  const runStart = performance.now();
  const name = basename(path);
  const { text, pages } = await processFile(path, name, lang);
  const stem = name.slice(0, name.length - extname(name).length);
  const outPath = join(dirname(path), `ocr-now ${lang.toUpperCase()} ${stem}.txt`);
  await writeFile(outPath, text);
  const totalDt = ((performance.now() - runStart) / 1000).toFixed(1);
  console.log(`wrote  ${outPath}  (${fmtBytes(text.length)}, ${pages} page${pages === 1 ? "" : "s"}, ${totalDt}s total)`);
}

async function loadConfig(): Promise<{ defaultLang?: string }> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveConfig(cfg: { defaultLang?: string }): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

async function listInstalledLangs(): Promise<string[]> {
  let res;
  try {
    res = await run(["tesseract", "--list-langs"]);
  } catch {
    throw new Error(`tesseract not found on PATH. Install with: brew install tesseract tesseract-lang`);
  }
  if (res.exitCode !== 0) {
    throw new Error(`tesseract --list-langs failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  // tesseract writes the list to stdout on newer versions, stderr on older — handle both.
  return (res.stdout + "\n" + res.stderr)
    .split("\n")
    .map(s => s.trim())
    .filter(s => s && /^[a-zA-Z0-9_]+$/.test(s) && s !== "List");
}

async function validateLang(lang: string): Promise<void> {
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
}

async function resolveLang(override: string | undefined): Promise<string> {
  const lang = (override?.trim()) || (await loadConfig()).defaultLang || HARDCODED_DEFAULT_LANG;
  await validateLang(lang);
  return lang;
}

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const a of argv) {
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? "";
    else positional.push(a);
  }
  return { flags, positional };
}

function printUsage() {
  console.error("Usage: ocr-now start [--lang=xxx]        # batch project's input/ folder");
  console.error("       ocr-now <file> [--lang=xxx]       # OCR a single file in place");
  console.error("       ocr-now --setDefaultLang=xxx      # persist the default language");
  console.error("");
  console.error("Languages use Tesseract ISO 639-2/T codes (e.g. eng, tur, deu, fra, spa).");
  console.error("Combine with '+': --lang=tur+eng");
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if ("setDefaultLang" in flags) {
    const lang = flags.setDefaultLang.trim();
    if (!lang) throw new Error(`--setDefaultLang requires a value, e.g. --setDefaultLang=eng`);
    await validateLang(lang);
    const cfg = await loadConfig();
    cfg.defaultLang = lang;
    await saveConfig(cfg);
    console.log(`default language set to "${lang}"  (saved to ${CONFIG_PATH})`);
    return;
  }

  const cmdOrFile = positional[0];
  if (!cmdOrFile) {
    printUsage();
    process.exit(1);
  }

  const lang = await resolveLang(flags.lang);

  if (cmdOrFile === "start") {
    await start(lang);
  } else {
    await single(cmdOrFile, lang);
  }
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
