import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { francAll } from "franc-min";
import { loadConfig, validateConfidence, validateSampleChars } from "./config";
import { listInstalledLangs, pickAutoBaseline } from "./lang";
import { PromiseQueue, run, runPool, trackTempDir, untrackTempDir } from "./shell";
import { isTty, renderBar, startSpinner } from "./tty";
import {
  AUTO, AUTO_DETECTION_DPI, AUTO_MIN_CONFIDENCE, AUTO_MIN_SAMPLE_CHARS,
  CONCURRENCY, FRANC_TO_TESS, classify, fmtBytes, pageNumOf,
} from "./util";

export type PageRange = [number, number];
export type PageText = { num: number; text: string };

export type RunOpts = {
  lang: string;
  dpi: number;
  pageRanges: PageRange[] | null;
  outFlag?: string;
  copy: boolean;
  stdout: boolean;
  json: boolean;
};

export function validatePageRanges(ranges: PageRange[], totalPages: number): void {
  for (const [lo, hi] of ranges) {
    if (hi > totalPages) {
      throw new Error(
        `--pages range ${lo === hi ? lo : `${lo}-${hi}`} is out of bounds (PDF has ${totalPages} page${totalPages === 1 ? "" : "s"})`,
      );
    }
  }
}

export function parsePages(spec: string): PageRange[] {
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

export function pagesToRanges(nums: number[]): PageRange[] {
  if (nums.length === 0) return [];
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const ranges: PageRange[] = [[sorted[0], sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    const last = ranges[ranges.length - 1];
    if (n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

export function renderPages(pages: PageText[]): string {
  return pages
    .slice()
    .sort((a, b) => a.num - b.num)
    .map(p => `--- Page ${p.num} ---\n${p.text.trim()}`)
    .join("\n\n");
}

export async function ocrImage(path: string, lang: string): Promise<string> {
  const { stdout, stderr, exitCode } = await run([
    "tesseract", path, "stdout", "-l", lang,
  ]);
  if (exitCode !== 0) throw new Error(`tesseract failed: ${stderr.trim()}`);
  return stdout;
}

async function getPdfPageCount(path: string): Promise<number> {
  const { stdout, stderr, exitCode } = await run(["pdfinfo", path]);
  if (exitCode !== 0) throw new Error(`pdfinfo failed: ${stderr.trim()}`);
  const m = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!m) throw new Error(`could not parse page count from pdfinfo output`);
  return parseInt(m[1], 10);
}

// pdfimages -list emits a header line, a dashes line, then one row per
// embedded raster image of the form "<page> <num> <type> ...". We pull
// the page numbers out so callers can distinguish a "short text" page
// from a genuinely scanned page.
export function parsePdfimagesOutput(stdout: string): Set<number> {
  const pages = new Set<number>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+\d+/.exec(line);
    if (m) pages.add(parseInt(m[1], 10));
  }
  return pages;
}

async function pagesWithImages(path: string): Promise<Set<number> | null> {
  try {
    const { stdout, exitCode } = await run(["pdfimages", "-list", path]);
    if (exitCode !== 0) return null;
    return parsePdfimagesOutput(stdout);
  } catch {
    return null;
  }
}

// Split ranges into chunks of ~equal page count, never crossing a range boundary.
export function planRasterTasks(ranges: PageRange[], workers: number): PageRange[] {
  const total = ranges.reduce((acc, [a, b]) => acc + (b - a + 1), 0);
  if (total === 0) return [];
  const chunkSize = Math.max(1, Math.ceil(total / workers));
  const tasks: PageRange[] = [];
  for (const [lo, hi] of ranges) {
    for (let s = lo; s <= hi; s += chunkSize) {
      tasks.push([s, Math.min(s + chunkSize - 1, hi)]);
    }
  }
  return tasks;
}

async function ocrPdf(
  path: string,
  lang: string,
  dpi: number,
  pageRanges: PageRange[] | null,
): Promise<{ pages: PageText[] }> {
  const tmp = await mkdtemp(join(tmpdir(), "ocr-now-"));
  trackTempDir(tmp);
  try {
    const effRanges: PageRange[] = pageRanges ?? [[1, await getPdfPageCount(path)]];
    const tasks = planRasterTasks(effRanges, CONCURRENCY);
    const totalPages = effRanges.reduce((acc, [a, b]) => acc + (b - a + 1), 0);
    const rangeLabel = pageRanges
      ? `pages ${pageRanges.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(",")}`
      : `${totalPages} page${totalPages === 1 ? "" : "s"}`;
    console.log(`       ocr pipeline (rasterize + recognize in parallel, ${rangeLabel}) @ ${dpi} dpi`);

    const queue = new PromiseQueue<string>();
    const pages: PageText[] = [];
    const tStart = performance.now();
    let done = 0;
    renderBar(0, totalPages, tStart);
    // Keep the bar's elapsed time moving during the initial bootstrap period
    // before the first PNG lands. Cleared once OCR is finished.
    const heartbeat = isTty() ? setInterval(() => renderBar(done, totalPages, tStart), 250) : null;

    const ocrWorkers = Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const name = await queue.take();
        if (!name) break;
        const text = await ocrImage(join(tmp, name), lang);
        pages.push({ num: pageNumOf(name) || 0, text });
        done++;
        renderBar(done, totalPages, tStart);
        if (!isTty()) console.log(`         page ${pageNumOf(name) || "?"} done (${done}/${totalPages})`);
      }
    });
    // Attach a rejection handler immediately (not just when we later await
    // it) so a worker failure (e.g. tesseract erroring on a page) doesn't
    // become an unhandled rejection while runPool is still rasterizing —
    // that would kill the process before the outer finally runs and leak
    // this temp dir. The real error still surfaces below via `await ocrDone`.
    const ocrDone = Promise.all(ocrWorkers);
    ocrDone.catch(() => {});

    try {
      try {
        await runPool(tasks, CONCURRENCY, async ([lo, hi]) => {
          const { exitCode, stderr } = await run([
            "pdftoppm", "-r", String(dpi), "-png", "-f", String(lo), "-l", String(hi),
            path, join(tmp, "page"),
          ]);
          if (exitCode !== 0) throw new Error(`pdftoppm failed: ${stderr.trim()}`);
          // After this chunk's pdftoppm exits, its PNGs are fully written.
          // Enqueue them for OCR. The lo/hi filter prevents double-pushing
          // files produced by other chunks that happen to be visible here.
          const all = await readdir(tmp);
          for (const f of all) {
            const n = pageNumOf(f);
            if (n >= lo && n <= hi && f.endsWith(".png")) queue.push(f);
          }
        });
      } finally {
        queue.close();
      }
      await ocrDone;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    if (isTty()) process.stdout.write("\n");

    if (pages.length === 0) throw new Error(`pdftoppm produced no pages (range out of bounds?)`);
    const dt = ((performance.now() - tStart) / 1000).toFixed(1);
    console.log(`       processed ${pages.length} page${pages.length === 1 ? "" : "s"} in ${dt}s`);
    return { pages };
  } finally {
    untrackTempDir(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}

async function detectFromSample(sample: string): Promise<string> {
  const baseline = await pickAutoBaseline();
  const cfg = await loadConfig();
  const minSampleChars = cfg.autoMinSampleChars !== undefined ? validateSampleChars(cfg.autoMinSampleChars) : AUTO_MIN_SAMPLE_CHARS;
  const minConfidence = cfg.autoMinConfidence !== undefined ? validateConfidence(cfg.autoMinConfidence) : AUTO_MIN_CONFIDENCE;
  const cleaned = sample.trim();
  if (cleaned.length < minSampleChars) {
    console.log(`auto   sample too short (${cleaned.length} chars), falling back to ${baseline}`);
    return baseline;
  }
  const installed = new Set(await listInstalledLangs());
  const ranked = francAll(cleaned)
    .map(([code, score]) => [FRANC_TO_TESS[code] ?? code, score] as [string, number])
    .filter(([code]) => installed.has(code));
  if (ranked.length === 0) {
    console.log(`auto   no installed language matched detection, falling back to ${baseline}`);
    return baseline;
  }
  const [primary, secondary] = ranked;
  if (primary[1] < minConfidence) {
    console.log(`auto   top match ${primary[0]} ${primary[1].toFixed(2)} below threshold ${minConfidence}, falling back to ${baseline}`);
    return baseline;
  }
  const tail = secondary ? `  (runner-up: ${secondary[0]} ${secondary[1].toFixed(2)})` : "";
  console.log(`auto   detected: ${primary[0]} ${primary[1].toFixed(2)}${tail} → --lang=${primary[0]}`);
  return primary[0];
}

async function detectLangFromImage(path: string, kind: "pdf" | "img"): Promise<string> {
  const baseline = await pickAutoBaseline();
  console.log(`auto   sampling ${kind === "pdf" ? "first page" : "image"} (${AUTO_DETECTION_DPI} dpi, ${baseline} baseline)`);

  let sampleText: string;
  if (kind === "img") {
    sampleText = await ocrImage(path, baseline);
  } else {
    const tmp = await mkdtemp(join(tmpdir(), "ocr-now-auto-"));
    trackTempDir(tmp);
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
      untrackTempDir(tmp);
      await rm(tmp, { recursive: true, force: true });
    }
  }

  return detectFromSample(sampleText);
}

type ExtractResult = {
  extracted: PageText[];
  needsOcr: number[];
  totalSelected: number;
  dtSec: string;
};

async function tryExtractText(
  path: string,
  pageRanges: PageRange[] | null,
): Promise<ExtractResult | null> {
  const t0 = performance.now();
  const { stdout, exitCode } = await run(["pdftotext", path, "-"]);
  if (exitCode !== 0) return null;

  const allPages = stdout.split("\f");
  if (allPages[allPages.length - 1] === "") allPages.pop();
  if (allPages.length === 0) return null;

  const selected: PageText[] = [];
  if (pageRanges) {
    for (const [lo, hi] of pageRanges) {
      for (let n = lo; n <= hi; n++) {
        if (n >= 1 && n <= allPages.length) selected.push({ num: n, text: allPages[n - 1] });
      }
    }
  } else {
    allPages.forEach((text, i) => selected.push({ num: i + 1, text }));
  }
  if (selected.length === 0) return null;

  const MIN_CHARS_PER_PAGE = 50;
  const extracted: PageText[] = [];
  const ambiguous: PageText[] = [];
  for (const p of selected) {
    if (p.text.trim().length >= MIN_CHARS_PER_PAGE) extracted.push(p);
    else ambiguous.push(p);
  }

  // Pages that returned <50 chars could be:
  //   (a) genuine scans (raster image, no embedded text)
  //   (b) legitimately short digital pages (continuation, section divider)
  //   (c) vector-content pages with no raster image and no extractable text
  //       (a flowchart with rendered labels, a chart with axis text)
  // Use pdfimages to detect raster content. If a page has no image and
  // some extracted text, trust pdftotext. If it has neither image nor
  // text, OCR it anyway since vector text would otherwise slip through.
  const needsOcr: number[] = [];
  if (ambiguous.length > 0) {
    const imagePages = await pagesWithImages(path);
    for (const p of ambiguous) {
      const hasImage = imagePages !== null && imagePages.has(p.num);
      const hasSomeText = p.text.trim().length > 0;
      if (imagePages === null || hasImage) needsOcr.push(p.num);
      else if (hasSomeText) extracted.push(p);
      else needsOcr.push(p.num);
    }
  }

  return {
    extracted,
    needsOcr,
    totalSelected: selected.length,
    dtSec: ((performance.now() - t0) / 1000).toFixed(2),
  };
}

function logDone(label: string, lang: string, pages: number, chars: number, t0: number): void {
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`done   ${label}  lang=${lang}  pages=${pages}  chars=${chars}  took=${dt}s`);
}

export async function processFile(
  path: string,
  label: string,
  opts: RunOpts,
): Promise<{ text: string; pages: number; kind: "pdf" | "img"; lang: string; pageTexts: PageText[] }> {
  const kind = classify(path);
  if (!kind) throw new Error(`unsupported file type: ${path}`);
  const size = fmtBytes((await stat(path)).size);
  console.log(`ocr    ${label}  [${kind}, ${size}]`);
  const t0 = performance.now();

  if (kind === "pdf" && opts.pageRanges) {
    const totalPages = await getPdfPageCount(path);
    validatePageRanges(opts.pageRanges, totalPages);
  }

  if (kind === "pdf") {
    const result = await tryExtractText(path, opts.pageRanges);
    if (result && result.extracted.length > 0) {
      if (result.needsOcr.length === 0) {
        // Pure text-embedded PDF: no OCR needed.
        const totalChars = result.extracted.reduce((acc, p) => acc + p.text.trim().length, 0);
        console.log(`       text-embedded PDF: extracted ${totalChars} chars across ${result.totalSelected} page${result.totalSelected === 1 ? "" : "s"} (${result.dtSec}s, no OCR needed)`);
        const text = renderPages(result.extracted);
        const lang = opts.lang === AUTO ? await detectFromSample(text) : opts.lang;
        logDone(label, lang, result.totalSelected, text.length, t0);
        return { text, pages: result.totalSelected, kind, lang, pageTexts: result.extracted };
      }
      // Hybrid: text on some pages, scans on others. Use extracted text for
      // auto-detection (no extra OCR pass needed) and OCR only the scanned pages.
      console.log(`       hybrid PDF: extracted text from ${result.extracted.length} page${result.extracted.length === 1 ? "" : "s"}, OCR needed for ${result.needsOcr.length} (${result.dtSec}s)`);
      const sampleText = result.extracted.map(p => p.text).join("\n");
      const lang = opts.lang === AUTO ? await detectFromSample(sampleText) : opts.lang;
      const ocrResult = await ocrPdf(path, lang, opts.dpi, pagesToRanges(result.needsOcr));
      const merged = [...result.extracted, ...ocrResult.pages];
      const text = renderPages(merged);
      logDone(label, lang, result.totalSelected, text.length, t0);
      return { text, pages: result.totalSelected, kind, lang, pageTexts: merged };
    }
  }

  const lang = opts.lang === AUTO ? await detectLangFromImage(path, kind) : opts.lang;

  let text: string;
  let pages = 1;
  let pageTexts: PageText[];
  if (kind === "pdf") {
    const r = await ocrPdf(path, lang, opts.dpi, opts.pageRanges);
    pageTexts = r.pages;
    text = renderPages(r.pages);
    pages = r.pages.length;
  } else {
    if (opts.pageRanges) console.log(`       (--pages ignored for image input)`);
    const stop = startSpinner("ocr");
    try {
      text = await ocrImage(path, lang);
    } finally {
      stop();
    }
    pageTexts = [{ num: 1, text }];
  }
  logDone(label, lang, pages, text.length, t0);
  return { text, pages, kind, lang, pageTexts };
}
