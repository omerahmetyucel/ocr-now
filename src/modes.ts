import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { type PageText, processFile, type RunOpts } from "./ocr";
import { copyToClipboard } from "./shell";
import { AUTO, CONCURRENCY, PROJECT_ROOT, classify, fmtBytes } from "./util";

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

function engineLine(opts: RunOpts): string {
  const pagesStr = opts.pageRanges
    ? `  pages=${opts.pageRanges.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(",")}`
    : "";
  return `engine tesseract  lang=${opts.lang}  dpi=${opts.dpi}  concurrency=${CONCURRENCY}${pagesStr}`;
}

export async function start(opts: RunOpts) {
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

  console.log(engineLine(opts));
  console.log(`input  ${inputDir}  (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);

  type Result = { file: string; name: string; lang: string; pages: number; text: string; pageTexts: PageText[] };
  const results: Result[] = [];
  let totalPages = 0;
  const runStart = performance.now();

  for (const name of entries) {
    const full = join(inputDir, name);
    if (!classify(full)) {
      console.log(`skip   ${name} (unsupported)`);
      continue;
    }
    const r = await processFile(full, name, opts);
    totalPages += r.pages;
    results.push({ file: full, name, lang: r.lang, pages: r.pages, text: r.text, pageTexts: r.pageTexts });
  }

  if (results.length === 0) {
    console.error("Nothing to OCR.");
    process.exit(1);
  }

  const body = opts.json
    ? JSON.stringify(
        results.map(r => ({ file: r.file, lang: r.lang, pages: r.pageTexts })),
        null,
        2,
      )
    : results
        .map(r => `========== ${r.name} [${r.lang.toUpperCase()}] ==========\n${r.text.trim()}\n`)
        .join("\n");
  const totalDt = ((performance.now() - runStart) / 1000).toFixed(1);

  if (opts.stdout) {
    process.stdout.write(body);
    console.log(`done   ${fmtBytes(body.length)}, ${totalPages} page${totalPages === 1 ? "" : "s"}, ${totalDt}s total (→ stdout)`);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filenameLang = opts.lang === AUTO ? "AUTO" : opts.lang.toUpperCase();
    const ext = opts.json ? "json" : "txt";
    const defaultPath = join(outputDir, `ocr-now ${filenameLang} ${stamp}.${ext}`);
    const outPath = await resolveOutPath(opts.outFlag, defaultPath);
    await writeFile(outPath, body);
    console.log(`wrote  ${outPath}  (${fmtBytes(body.length)}, ${totalPages} page${totalPages === 1 ? "" : "s"}, ${totalDt}s total)`);
  }

  if (opts.copy) {
    await copyToClipboard(body);
    console.log(`copied to clipboard (${body.length} chars)`);
  }
}

export async function single(arg: string, opts: RunOpts) {
  const path = resolve(process.cwd(), arg);
  let s;
  try {
    s = await stat(path);
  } catch {
    throw new Error(`not found: ${path}`);
  }
  if (!s.isFile()) throw new Error(`not a file: ${path}`);
  if (!classify(path)) throw new Error(`unsupported file type: ${path}`);

  console.log(engineLine(opts));
  console.log(`file   ${path}`);

  const runStart = performance.now();
  const name = basename(path);
  const { text, pages, lang, pageTexts } = await processFile(path, name, opts);
  const totalDt = ((performance.now() - runStart) / 1000).toFixed(1);

  const body = opts.json
    ? JSON.stringify({ file: path, lang, pages: pageTexts }, null, 2)
    : text;

  if (opts.stdout) {
    process.stdout.write(body);
    console.log(`done   ${fmtBytes(body.length)}, ${pages} page${pages === 1 ? "" : "s"}, ${totalDt}s total (→ stdout)`);
  } else {
    const stem = name.slice(0, name.length - extname(name).length);
    const ext = opts.json ? "json" : "txt";
    const defaultPath = join(dirname(path), `ocr-now ${lang.toUpperCase()} ${stem}.${ext}`);
    const outPath = await resolveOutPath(opts.outFlag, defaultPath);
    await writeFile(outPath, body);
    console.log(`wrote  ${outPath}  (${fmtBytes(body.length)}, ${pages} page${pages === 1 ? "" : "s"}, ${totalDt}s total)`);
  }

  if (opts.copy) {
    await copyToClipboard(body);
    console.log(`copied to clipboard (${body.length} chars)`);
  }
}
