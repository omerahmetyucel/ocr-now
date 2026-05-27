#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { KNOWN_COMMANDS, flagStr, looksLikePath, parseArgs, suggestCommand } from "./args";
import {
  type Config, VALID_CONFIG_KEYS, isValidKey,
  loadConfig, resolveDpi, saveConfig, validateDpi,
} from "./config";
import { listInstalledLangs, resolveLang, validateLang } from "./lang";
import { single, start } from "./modes";
import { parsePages, type RunOpts } from "./ocr";
import { AUTO, CONFIG_PATH, HARDCODED_DEFAULT_DPI, HARDCODED_DEFAULT_LANG } from "./util";

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
  out("  --stdout            write result to stdout instead of a file (for piping)");
  out("  --quiet             suppress progress output (errors still print)");
  out("  -h, --help          show this help");
  out("  -v, --version       print version");
  out("");
  out("Examples:");
  out("  ocr-now config set defaultLang eng");
  out("  ocr-now ~/Downloads/foo.pdf --lang=auto --copy");
  out("  ocr-now start --dpi=400 --out=~/Desktop/");
}

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
    delete cfg[key as keyof Config];
    await saveConfig(cfg);
    console.log(`unset ${key}`);
    return;
  }

  throw new Error(`Usage: ocr-now config [list | get <key> | set <key> <value> | unset <key>]`);
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

  const stdout = flags.stdout === true;
  const quiet = flags.quiet === true;
  if (stdout || quiet) {
    // Force non-TTY so spinner/progress bar don't paint anywhere.
    (process.stdout as { isTTY?: boolean }).isTTY = false;
  }
  if (quiet) {
    console.log = () => {};
  } else if (stdout) {
    // Route status logs to stderr so stdout carries only the OCR text.
    console.log = (...args: unknown[]) => console.error(...(args as Parameters<typeof console.error>));
  }

  const lang = await resolveLang(flagStr(flags.lang));
  const dpi = await resolveDpi(flagStr(flags.dpi));
  const pageRanges = flagStr(flags.pages) ? parsePages(flagStr(flags.pages)!) : null;
  const outFlag = flagStr(flags.out);
  const copy = Boolean(flags.copy);

  const opts: RunOpts = { lang, dpi, pageRanges, outFlag, copy, stdout };

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
