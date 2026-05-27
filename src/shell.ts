export type RunResult = { stdout: string; stderr: string; exitCode: number };

const INSTALL_HINTS: Record<string, string> = {
  tesseract: "brew install tesseract tesseract-lang",
  pdftoppm: "brew install poppler",
  pdfinfo: "brew install poppler",
  pdftotext: "brew install poppler",
  pbcopy: "pbcopy ships with macOS; --copy is macOS-only",
};

function isNotFoundError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === "ENOENT") return true;
  const msg = (e as { message?: string })?.message ?? String(e);
  return /not found|no such file|executable file not found/i.test(msg);
}

export async function run(cmd: string[]): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
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

export async function copyToClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(["pbcopy"], { stdin: new Blob([text]) });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`pbcopy exited with code ${exitCode}`);
}
