export const isTty = Boolean(process.stdout.isTTY);

export function startSpinner(label: string): () => void {
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

export function renderBar(done: number, total: number, t0: number) {
  if (!isTty) return;
  const width = 24;
  const filled = Math.round((done / total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = Math.round((done / total) * 100);
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\r\x1b[2K       [${bar}] ${done}/${total} (${pct}%) ${dt}s`);
}
