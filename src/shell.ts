import { rmSync } from "node:fs";

export type RunResult = { stdout: string; stderr: string; exitCode: number };

// JS finally blocks don't fire on SIGINT/SIGTERM, so mkdtemp'd directories
// leak on Ctrl+C mid-run (especially painful at high DPI where pdftoppm
// drops hundreds of MB into /tmp). Track active temp dirs and remove
// them synchronously from a signal handler.
const activeTempDirs = new Set<string>();
let signalsInstalled = false;

function installSignalHandlers(): void {
  signalsInstalled = true;
  const cleanup = (code: number) => {
    for (const dir of activeTempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    activeTempDirs.clear();
    process.exit(code);
  };
  process.on("SIGINT", () => cleanup(130));
  process.on("SIGTERM", () => cleanup(143));
}

export function trackTempDir(path: string): void {
  if (!signalsInstalled) installSignalHandlers();
  activeTempDirs.add(path);
}

export function untrackTempDir(path: string): void {
  activeTempDirs.delete(path);
}

const INSTALL_HINTS: Record<string, string> = {
  tesseract: "brew install tesseract tesseract-lang",
  pdftoppm: "brew install poppler",
  pdfinfo: "brew install poppler",
  pdftotext: "brew install poppler",
  pdfimages: "brew install poppler",
  pbcopy: "pbcopy ships with macOS; --copy is macOS-only",
};

function isNotFoundError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === "ENOENT") return true;
  const msg = (e as { message?: string })?.message ?? String(e);
  return /not found|no such file|executable file not found/i.test(msg);
}

export async function run(cmd: string[], opts?: { stdin?: Blob }): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: opts?.stdin });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch (e) {
    if (isNotFoundError(e)) {
      const bin = cmd[0];
      const hint = INSTALL_HINTS[bin];
      throw new Error(
        hint
          ? `${bin} not found on PATH. ${hint.startsWith("pbcopy") ? hint : `Install with: ${hint}`}`
          : `${bin} not found on PATH`,
      );
    }
    throw e;
  }
}

export async function runPool<T, R>(
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

// A single-producer / multi-consumer queue used to stream rasterized PNGs
// into the OCR pool as soon as each pdftoppm chunk completes.
export class PromiseQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | undefined) => void> = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!(undefined);
  }

  async take(): Promise<T | undefined> {
    if (this.items.length) return this.items.shift();
    if (this.closed) return undefined;
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export async function copyToClipboard(text: string): Promise<void> {
  const { exitCode } = await run(["pbcopy"], { stdin: new Blob([text]) });
  if (exitCode !== 0) throw new Error(`pbcopy exited with code ${exitCode}`);
}
