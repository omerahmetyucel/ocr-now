# ocr-now

Thin Bun CLI over Tesseract. Takes PDFs and images, dumps text. Defaults to Turkish.

## Requirements

- [Bun](https://bun.sh)
- Tesseract + language data
- Poppler (for `pdftoppm`)

```
brew install tesseract tesseract-lang poppler
```

## Install

```
git clone https://github.com/jericho909/ocr-now.git
cd ocr-now
bun install
bun link
```

`ocr-now` is now on your PATH.

## Usage

```
ocr-now start [opts]                       # batch project's input/ folder
ocr-now <file> [opts]                      # OCR a single file in place
ocr-now config [list|get|set|unset] ...    # inspect or change settings
ocr-now langs                              # list installed tesseract languages
ocr-now -h | --help                        # show help
ocr-now -v | --version                     # print version
```

PDF pages are OCR'd in parallel (capped at 6 workers or your CPU core count, whichever is lower). Page order in the output file is preserved regardless of completion order.

If a PDF has embedded text on every selected page (most digitally-generated PDFs do), `ocr-now` extracts it directly via `pdftotext` and skips OCR entirely — a 144-page text PDF goes from ~75s to <1s. Scanned PDFs still go through the OCR pipeline.

### Batch mode

Drop PDFs/images into `input/`, then:

```
ocr-now start
```

Writes one combined file to `output/ocr-now <LANG> <timestamp>.txt`. The `input/` and `output/` folders are created automatically on first run.

### Single-file mode

```
ocr-now ~/Downloads/invoice.pdf
```

Writes `ocr-now <LANG> invoice.txt` next to the source file.

Filenames with spaces or special chars: quote them, or use tab completion.

## Flags

| Flag | Purpose |
|---|---|
| `--lang=xxx` | Tesseract lang code. Multi-language with `+`: `--lang=tur+eng`. Use `auto` to detect |
| `--dpi=N` | Rasterize PDFs at N dpi. Range 72–600. Default 300 |
| `--pages=1-3,7` | PDF only. OCR a subset of pages. Non-contiguous allowed |
| `--out=<path>` | Override output. Treated as a directory if it ends in `/` or already exists as one; otherwise as a file path |
| `--copy` | Also copy result to clipboard. macOS only (uses `pbcopy`) |
| `--stdout` | Write result to stdout instead of a file. Status logs go to stderr so output pipes cleanly: `ocr-now foo.pdf --stdout \| grep keyword` |

All stackable. Example:

```
ocr-now ~/Downloads/long.pdf --pages=1-2,5 --dpi=400 --copy
```

## Config

Persistent settings live in `config.json` at the project root.

```
ocr-now config list
ocr-now config get defaultLang
ocr-now config set defaultLang eng
ocr-now config set defaultDpi 400
ocr-now config unset defaultDpi
```

Valid keys: `defaultLang`, `defaultDpi`.

Resolution order for each setting: flag → config → built-in default (`tur`, `300`).

`defaultLang` accepts `auto` as a special value — see below.

## Auto language detection

```
ocr-now ~/Downloads/foo.pdf --lang=auto
ocr-now config set defaultLang auto
```

Auto mode runs a quick low-DPI sample pass with `eng` as the baseline, runs [`franc-min`](https://github.com/wooorm/franc) on the resulting text, then re-OCRs with the detected language. Cost: ~1–3s extra per file.

Notes:
- Picks the single best match. If your doc is genuinely bilingual, pass `--lang=tur+eng` explicitly — single-pass detection isn't suited to multi-language inference.
- Fall back to the baseline if the sample text is too short or no installed language matches.
- Detected language is shown per file and used in the output filename. Batch-mode combined output uses `AUTO` in the filename since files may differ; the per-file section header (`[LANG]`) shows what was actually used.

## Languages

Tesseract uses ISO 639-2/T codes: `eng`, `tur`, `deu`, `fra`, `spa`, `ita`, `por`, `rus`, `ara`, `chi_sim`, `jpn`, `kor`, etc. Run `tesseract --list-langs` to see what's installed.

If you pass a code that isn't installed, `ocr-now` aborts and prints your installed list before doing any work.

## Output format

One file per run. Each source file gets a section:

```
========== filename [TUR] ==========
--- Page 1 ---
<text>

--- Page 2 ---
<text>
```

The `[LANG]` suffix in the section header shows the language actually used for that file (useful with `--lang=auto`).

Single-file mode skips the `========` header (single source).

## Third-party tools

`ocr-now` is a thin wrapper. The actual work is done by:

| Tool | License | Link |
|---|---|---|
| [Tesseract](https://github.com/tesseract-ocr/tesseract) | Apache 2.0 | invoked as a subprocess |
| [Poppler](https://poppler.freedesktop.org/) (`pdftoppm`, `pdfinfo`, `pdftotext`) | GPL | invoked as a subprocess |
| [franc-min](https://github.com/wooorm/franc) | MIT | npm dependency |

Subprocess invocation is arm's-length communication — `ocr-now`'s MIT license is not affected by Poppler's GPL. Users install Poppler and Tesseract themselves via Homebrew; this project does not redistribute either.

## License

MIT. See [LICENSE](LICENSE).
