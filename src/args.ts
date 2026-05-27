export const KNOWN_COMMANDS = ["start", "config", "langs"];

const SHORT_FLAGS: Record<string, string> = { "-h": "help", "-v": "version" };

export function parseArgs(argv: string[]): {
  flags: Record<string, string | true>;
  positional: string[];
} {
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

export function flagStr(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function looksLikePath(s: string): boolean {
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

export function suggestCommand(input: string): string | null {
  const lower = input.toLowerCase();
  let best: { cmd: string; dist: number } | null = null;
  for (const cmd of KNOWN_COMMANDS) {
    const d = levenshtein(lower, cmd);
    if (d <= 2 && (!best || d < best.dist)) best = { cmd, dist: d };
  }
  return best?.cmd ?? null;
}
