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
git clone <repo> ocr-now && cd ocr-now
bun link
```

`ocr-now` is now on your PATH.

## Usage

```
ocr-now start [opts]                       # batch project's input/ folder
ocr-now <file> [opts]                      # OCR a single file in place
ocr-now config [list|get|set|unset] ...    # inspect or change settings
```

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
| `--lang=xxx` | Tesseract lang code. Multi-language with `+`: `--lang=tur+eng` |
| `--dpi=N` | Rasterize PDFs at N dpi. Range 72–600. Default 300 |
| `--pages=1-3,7` | PDF only. OCR a subset of pages. Non-contiguous allowed |
| `--out=<path>` | Override output. Directory or file path |
| `--copy` | Also copy result to clipboard (`pbcopy`) |

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

## Languages

Tesseract uses ISO 639-2/T codes: `eng`, `tur`, `deu`, `fra`, `spa`, `ita`, `por`, `rus`, `ara`, `chi_sim`, `jpn`, `kor`, etc. Run `tesseract --list-langs` to see what's installed.

If you pass a code that isn't installed, `ocr-now` aborts and prints your installed list before doing any work.

## Output format

One file per run. Each source file gets a section:

```
========== filename ==========
--- Page 1 ---
<text>

--- Page 2 ---
<text>
```

Single-file mode skips the `========` header (single source).

## License

MIT. See [LICENSE](LICENSE).
