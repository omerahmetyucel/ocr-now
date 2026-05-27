#!/usr/bin/env bun
import { readdir, mkdir, writeFile, rm, mkdtemp, stat, readFile } from "node:fs/promises";
import { join, extname, dirname, basename, resolve } from "node:path";
import { tmpdir, cpus } from "node:os";
import { francAll } from "franc-min";
import pkg from "../package.json" with { type: "json" };

const AUTO = "auto";
const HARDCODED_DEFAULT_LANG = "tur";
const HARDCODED_DEFAULT_DPI = 300;
const DPI_MIN = 72;
const DPI_MAX = 600;
const AUTO_DETECTION_DPI = "150";
const AUTO_MIN_SAMPLE_CHARS = 20;
const CONCURRENCY = Math.max(1, Math.min(6, cpus().length));
// ISO 639-3 (franc) → Tesseract code, only for entries that aren't identity.
const FRANC_TO_TESS: Record<string, string> = {
  cmn: "chi_sim",
  yue: "chi_tra",
  zho: "chi_sim",
};
const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif",
]);
const PROJECT_ROOT = dirname(import.meta.dir);
const CONFIG_PATH = join(PROJECT_ROOT, "config.json");
const VALID_CONFIG_KEYS = ["defaultLang", "defaultDpi"] as const;
type ConfigKey = (typeof VALID_CONFIG_KEYS)[number];
type Config = { defaultLang?: string; defaultDpi?: number };

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

async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
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

// ---------- config ----------

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function isValidKey(k: string): k is ConfigKey {
  return (VALID_CONFIG_KEYS as readonly string[]).includes(k);
}

// ---------- lang ----------

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
  return (res.stdout + "\n" + res.stderr)
    .split("\n")
    .map(s => s.trim())
    .filter(s => s && /^[a-zA-Z0-9_]+$/.test(s) && s !== "List");
}

async function validateLang(lang: string): Promise<string> {
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

async function resolveLang(override: string | undefined): Promise<string> {
  const lang = (override?.trim()) || (await loadConfig()).defaultLang || HARDCODED_DEFAULT_LANG;
  if (lang === AUTO) return AUTO; // validated at detection time
  await validateLang(lang);
  return lang;
}

async function pickAutoBaseline(): Promise<string> {
  const installed = await listInstalledLangs();
  if (installed.includes("eng")) return "eng";
  const cfg = await loadConfig();
  if (cfg.defaultLang && cfg.defaultLang !== AUTO && installed.includes(cfg.defaultLang)) {
    return cfg.defaultLang;
  }
  if (installed.length === 0) throw new Error(`no tesseract languages installed`);
  return installed.sort()[0];
}

async function detectLang(
  path: string,
  kind: "pdf" | "img",
): Promise<string> {
  const baseline = await pickAutoBaseline();
  console.log(`auto   sampling ${kind === "pdf" ? "first page" : "image"} (${AUTO_DETECTION_DPI} dpi, ${baseline} baseline)`);

  let sampleText: string;
  if (kind === "img") {
    sampleText = await ocrImage(path, baseline);
  } else {
    const tmp = await mkdtemp(join(tmpdir(), "ocr-now-auto-"));
    try {
      const { exitCode, stderr } = await run([
        "pdftoppm", "-r", AUTO_DETECTION_DPI, "-png", "-f", "1", "-l", "1",
        path, join(tmp, "page"),
      ]);
      if (exitCode !== 0) throw new Error(`pdftoppm failed during auto-detect: ${stderr.trim()}`);
      const pngs = (await readdir(tmp)).filter(f => f.endsWith(".png")).sort();
      if (pngs.length === 0) throw new Error(`pdftoppm produced no pages for auto-detect`);
      sampleText = await ocrImage(join(tmp, pngs[0]), baseline);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  const cleaned = sampleText.trim();
  if (cleaned.length < AUTO_MIN_SAMPLE_CHARS) {
    console.log(`auto   sample too short (${cleaned.length} chars), falling back to ${baseline}`);
    return baseline;
  }

  const installed = new Set(await listInstalledLangs());
  const ranked = francAll(cleaned)
    .map(([code, score]) => [FRANC_TO_TESS[code] ?? code, score] as [string, number])
    .filter(([code, score]) => installed.has(code) && score > 0);

  if (ranked.length === 0) {
    console.log(`auto   no installed language matched detection, falling back to ${baseline}`);
    return baseline;
  }

  const [primary, secondary] = ranked;
  const tail = secondary ? `  (runner-up: ${secondary[0]} ${secondary[1].toFixed(2)})` : "";
  console.log(`auto   detected: ${primary[0]} ${primary[1].toFixed(2)}${tail} → --lang=${primary[0]}`);
  return primary[0];
}

// ---------- dpi ----------

function validateDpi(value: string | number): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`dpi must be an integer`);
  if (n < DPI_MIN || n > DPI_MAX) throw new Error(`dpi must be between ${DPI_MIN} and ${DPI_MAX}`);
  return n;
}

async function resolveDpi(override: string | undefined): Promise<number> {
  if (override !== undefined && override !== "") return validateDpi(override);
  const cfg = await loadConfig();
  return cfg.defaultDpi ?? HARDCODED_DEFAULT_DPI;
}

// ---------- pages ----------

type PageRange = [number, number];

function parsePages(spec: string): PageRange[] {
  const ranges: PageRange[] = [];
  for (const part of spec.split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid --pages segment: "${part}" (expected N or N-M)`);
    const lo = parseInt(m[1], 10);
    const hi = m[2] ? parseInt(m[2], 10) : lo;
    if (lo < 1) throw new Error(`--pages values must be >= 1 (got "${part}")`);
    if (hi < lo) throw new Error(`--pages range "${part}" has end < start`);
    ranges.push([lo, hi]);
  }
  if (ranges.length === 0) throw new Error(`--pages requires a value, e.g. --pages=1-3,7`);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: PageRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

// ---------- ocr ----------

async function ocrImage(path: string, lang: string): Promise<string> {
  const { stdout, stderr, exitCode } = await run([
    "tesseract", path, "stdout", "-l", lang,
  ]);
  if (exitCode !== 0) throw new Error(`tesseract failed: ${stderr.trim()}`);
  return stdout;
}

function pageNumOf(filename: string): number {
  const m = /-(\d+)\.png$/.exec(filename);
  return m ? parseInt(m[1], 10) : 0;
}

async function ocrPdf(
  path: string,
  lang: string,
  dpi: number,
  pageRanges: PageRange[] | null,
): Promise<{ text: string; pages: number }> {
  const tmp = await mkdtemp(join(tmpdir(), "ocr-now-"));
  try {
    const label = pageRanges
      ? `rasterizing pdf (pages ${pageRanges.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(",")})`
      : "rasterizing pdf";
    const stopSpinner = startSpinner(label);
    const tRast = performance.now();
    const prefix = join(tmp, "page");
    const baseArgs = ["pdftoppm", "-r", String(dpi), "-png"];

    if (pageRanges) {
      for (const [lo, hi] of pageRanges) {
        const { exitCode, stderr } = await run([
          ...baseArgs, "-f", String(lo), "-l", String(hi), path, prefix,
        ]);
        if (exitCode !== 0) {
          stopSpinner();
          throw new Error(`pdftoppm failed: ${stderr.trim()}`);
        }
      }
    } else {
      const { exitCode, stderr } = await run([...baseArgs, path, prefix]);
      if (exitCode !== 0) {
        stopSpinner();
        throw new Error(`pdftoppm failed: ${stderr.trim()}`);
      }
    }
    stopSpinner();

    const pngs = (await readdir(tmp))
      .filter(f => f.endsWith(".png"))
      .sort((a, b) => pageNumOf(a) - pageNumOf(b));
    if (pngs.length === 0) throw new Error(`pdftoppm produced no pages (range out of bounds?)`);
    const rastDt = ((performance.now() - tRast) / 1000).toFixed(1);
    console.log(`       rasterized ${pngs.length} page${pngs.length === 1 ? "" : "s"} @ ${dpi} dpi (${rastDt}s)`);

    const tOcr = performance.now();
    let done = 0;
    renderBar(0, pngs.length, tOcr);
    const texts = await runPool(pngs, CONCURRENCY, async name => {
      const text = await ocrImage(join(tmp, name), lang);
      done++;
      renderBar(done, pngs.length, tOcr);
      if (!isTty) console.log(`         page ${pageNumOf(name) || "?"} done (${done}/${pngs.length})`);
      return text;
    });
    if (isTty) process.stdout.write("\n");
    const parts = pngs.map((name, i) => {
      const pageNum = pageNumOf(name) || i + 1;
      return `--- Page ${pageNum} ---\n${texts[i].trim()}`;
    });
    return { text: parts.join("\n\n"), pages: pngs.length };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------- shared per-file driver ----------

type RunOpts = {
  lang: string;
  dpi: number;
  pageRanges: PageRange[] | null;
  outFlag?: string;
  copy: boolean;
};

async function processFile(
  path: string,
  label: string,
  opts: RunOpts,
): Promise<{ text: string; pages: number; kind: "pdf" | "img"; lang: string }> {
  const kind = classify(path);
  if (!kind) throw new Error(`unsupported file type: ${path}`);
  const size = fmtBytes((await stat(path)).size);
  console.log(`ocr    ${label}  [${kind}, ${size}]`);
  const t0 = performance.now();

  const lang = opts.lang === AUTO ? await detectLang(path, kind) : opts.lang;

  let text: string;
  let pages = 1;
  if (kind === "pdf") {
    const r = await ocrPdf(path, lang, opts.dpi, opts.pageRanges);
    text = r.text;
    pages = r.pages;
  } else {
    if (opts.pageRanges) console.log(`       (--pages ignored for image input)`);
    const stop = startSpinner("ocr");
    try {
      text = await ocrImage(path, lang);
    } finally {
      stop();
    }
  }
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`done   ${label}  lang=${lang}  pages=${pages}  chars=${text.length}  took=${dt}s`);
  return { text, pages, kind, lang };
}

// ---------- output / clipboard ----------

async function resolveOutPath(outFlag: string | undefined, defaultPath: string): Promise<string> {
  if (!outFlag) {
    await mkdir(dirname(defaultPath), { recursive: true });
    return defaultPath;
  }
  const abs = resolve(process.cwd(), outFlag);
  let isDir = outFlag.endsWith("/");
  try {
    const s = await stat(abs);
    if (s.isDirectory()) isDir = true;
  } catch {}
  if (isDir) {
    await mkdir(abs, { recursive: true });
    return join(abs, basename(defaultPath));
  }
  await mkdir(dirname(abs), { recursive: true });
  return abs;
}

async function copyToClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(["pbcopy"], { stdin: new Blob([text]) });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`pbcopy exited with code ${exitCode}`);
}

// ---------- modes ----------

async function start(opts: RunOpts) {
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

  console.log(`engine tesseract  lang=${opts.lang}  dpi=${opts.dpi}  concurrency=${CONCURRENCY}${opts.pageRanges ? `  pages=${opts.pageRanges.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(",")}` : ""}`);
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
    const { text, pages, lang } = await processFile(full, name, opts);
    totalPages += pages;
    sections.push(`========== ${name} [${lang.toUpperCase()}] ==========\n${text.trim()}\n`);
  }

  if (sections.length === 0) {
    console.error("Nothing to OCR.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filenameLang = opts.lang === AUTO ? "AUTO" : opts.lang.toUpperCase();
  const defaultPath = join(outputDir, `ocr-now ${filenameLang} ${stamp}.txt`);
  const outPath = await resolveOutPath(opts.outFlag, defaultPath);
  const body = sections.join("\n");
  await writeFile(outPath, body);
  const totalDt = ((performance.now() - runStart) / 1000).toFixed(1);
  console.log(`wrote  ${outPath}  (${fmtBytes(body.length)}, ${totalPages} page${totalPages === 1 ? "" : "s"}, ${totalDt}s total)`);

  if (opts.copy) {
    await copyToClipboard(body);
    console.log(`copied to clipboard (${body.length} chars)`);
  }
}

async function single(arg: string, opts: RunOpts) {
  const path = resolve(process.cwd(), arg);
  let s;
  try {
    s = await stat(path);
  } catch {
    throw new Error(`not found: ${path}`);
  }
  if (!s.isFile()) throw new Error(`not a file: ${path}`);
  if (!classify(path)) throw new Error(`unsupported file type: ${path}`);

  console.log(`engine tesseract  lang=${opts.lang}  dpi=${opts.dpi}  concurrency=${CONCURRENCY}${opts.pageRanges ? `  pages=${opts.pageRanges.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(",")}` : ""}`);
  console.log(`file   ${path}`);

  const runStart = performance.now();
  const name = basename(path);
  const { text, pages, lang } = await processFile(path, name, opts);
  const stem = name.slice(0, name.length - extname(name).length);
  const defaultPath = join(dirname(path), `ocr-now ${lang.toUpperCase()} ${stem}.txt`);
  const outPath = await resolveOutPath(opts.outFlag, defaultPath);
  await writeFile(outPath, text);
  const totalDt = ((performance.now() - runStart) / 1000).toFixed(1);
  console.log(`wrote  ${outPath}  (${fmtBytes(text.length)}, ${pages} page${pages === 1 ? "" : "s"}, ${totalDt}s total)`);

  if (opts.copy) {
    await copyToClipboard(text);
    console.log(`copied to clipboard (${text.length} chars)`);
  }
}

// ---------- config subcommand ----------

async function configCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  const cfg = await loadConfig();

  if (sub === "list") {
    console.log(`config file: ${CONFIG_PATH}`);
    const langSet = cfg.defaultLang !== undefined;
    const dpiSet = cfg.defaultDpi !== undefined;
    console.log(`  defaultLang = ${cfg.defaultLang ?? HARDCODED_DEFAULT_LANG}${langSet ? "" : "  (default)"}`);
    console.log(`  defaultDpi  = ${cfg.defaultDpi ?? HARDCODED_DEFAULT_DPI}${dpiSet ? "" : "  (default)"}`);
    return;
  }

  if (sub === "get") {
    const key = args[1];
    if (!key) throw new Error(`Usage: ocr-now config get <key>`);
    if (!isValidKey(key)) throw new Error(`unknown key "${key}". Valid: ${VALID_CONFIG_KEYS.join(", ")}`);
    const val = cfg[key] ?? (key === "defaultLang" ? HARDCODED_DEFAULT_LANG : HARDCODED_DEFAULT_DPI);
    console.log(String(val));
    return;
  }

  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) throw new Error(`Usage: ocr-now config set <key> <value>`);
    if (!isValidKey(key)) throw new Error(`unknown key "${key}". Valid: ${VALID_CONFIG_KEYS.join(", ")}`);
    if (key === "defaultLang") {
      const normalized = value.trim() === AUTO ? AUTO : await validateLang(value);
      cfg.defaultLang = normalized;
      await saveConfig(cfg);
      console.log(`set defaultLang = ${normalized}`);
    } else {
      const n = validateDpi(value);
      cfg.defaultDpi = n;
      await saveConfig(cfg);
      console.log(`set defaultDpi = ${n}`);
    }
    return;
  }

  if (sub === "unset") {
    const key = args[1];
    if (!key) throw new Error(`Usage: ocr-now config unset <key>`);
    if (!isValidKey(key)) throw new Error(`unknown key "${key}". Valid: ${VALID_CONFIG_KEYS.join(", ")}`);
    delete cfg[key];
    await saveConfig(cfg);
    console.log(`unset ${key}`);
    return;
  }

  throw new Error(`Usage: ocr-now config [list | get <key> | set <key> <value> | unset <key>]`);
}

// ---------- arg parsing & dispatch ----------

const SHORT_FLAGS: Record<string, string> = { "-h": "help", "-v": "version" };

function parseArgs(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (const a of argv) {
    if (a in SHORT_FLAGS) {
      flags[SHORT_FLAGS[a]] = true;
      continue;
    }
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true;
    else positional.push(a);
  }
  return { flags, positional };
}

function flagStr(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const KNOWN_COMMANDS = ["start", "config", "langs"];

function looksLikePath(s: string): boolean {
  return s.includes("/") || s.includes(".") || s.startsWith("~");
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}

function suggestCommand(input: string): string | null {
  const lower = input.toLowerCase();
  let best: { cmd: string; dist: number } | null = null;
  for (const cmd of KNOWN_COMMANDS) {
    const d = levenshtein(lower, cmd);
    if (d <= 2 && (!best || d < best.dist)) best = { cmd, dist: d };
  }
  return best?.cmd ?? null;
}

function printUsage(toStdout = false) {
  const out = toStdout ? console.log : console.error;
  out("Usage:");
  out("  ocr-now start [opts]                       # batch project's input/ folder");
  out("  ocr-now <file> [opts]                      # OCR a single file in place");
  out("  ocr-now config [list|get|set|unset] ...    # inspect or change settings");
  out("  ocr-now langs                              # list installed tesseract languages");
  out("");
  out("Options:");
  out("  --lang=xxx          tesseract lang code (e.g. eng, tur, tur+eng, or 'auto')");
  out("  --dpi=N             rasterize PDFs at N dpi (72-600, default 300)");
  out("  --pages=1-3,7       PDF only: OCR a subset of pages");
  out("  --out=<path>        override output file or directory");
  out("  --copy              also copy result to clipboard (pbcopy)");
  out("  -h, --help          show this help");
  out("  -v, --version       print version");
  out("");
  out("Examples:");
  out("  ocr-now config set defaultLang eng");
  out("  ocr-now ~/Downloads/foo.pdf --lang=auto --copy");
  out("  ocr-now start --dpi=400 --out=~/Desktop/");
}

async function langsCommand(): Promise<void> {
  const langs = (await listInstalledLangs()).sort();
  console.log(`installed tesseract languages (${langs.length}):`);
  for (const l of langs) console.log(`  ${l}`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (flags.help === true || flags.h === true) {
    printUsage(true);
    return;
  }
  if (flags.version === true || flags.v === true) {
    console.log(pkg.version);
    return;
  }

  if (cmd === "config") {
    await configCommand(positional.slice(1));
    return;
  }
  if (cmd === "langs") {
    await langsCommand();
    return;
  }

  if (!cmd) {
    printUsage();
    process.exit(1);
  }

  const lang = await resolveLang(flagStr(flags.lang));
  const dpi = await resolveDpi(flagStr(flags.dpi));
  const pageRanges = flagStr(flags.pages) ? parsePages(flagStr(flags.pages)!) : null;
  const outFlag = flagStr(flags.out);
  const copy = Boolean(flags.copy);

  const opts: RunOpts = { lang, dpi, pageRanges, outFlag, copy };

  if (cmd === "start") {
    await start(opts);
  } else if (looksLikePath(cmd)) {
    await single(cmd, opts);
  } else {
    const hint = suggestCommand(cmd);
    if (hint) {
      console.error(`unknown command "${cmd}". Did you mean "${hint}"?`);
    } else {
      console.error(`unknown command "${cmd}". Available: ${KNOWN_COMMANDS.join(", ")}.`);
      console.error(`To OCR a file, pass a path containing "/" or a file extension (e.g. ./${cmd}.pdf).`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
