---
name: docx
description: Create, read, edit and verify Word documents (.docx) with local CLI tools only — LibreOffice, unzip/zip, no pandoc required. Use when producing or inspecting .docx/.doc files.
---

# docx

Working .docx files with whatever the machine actually has installed.
A `.docx` is a ZIP archive of XML (`word/document.xml` plus styles,
relationships, `[Content_Types].xml`). Everything below follows from that.

## Probe first

Run once before choosing a strategy — tool availability differs per machine:

```bash
command -v soffice unzip zip magick node pdftoppm pandoc
```

Never assume `pandoc`, `pdftoppm`, `python-docx` or the npm `docx` package exist. Treat them as optional accelerators, not dependencies.

## Create

**Default path — HTML → docx via LibreOffice (always available if soffice is):**

1. Write the content as a single `.html` file. Use inline styles for document
   formatting: `font-family`, `font-size`, `line-height`, `text-align`,
   margins via `@page` CSS.
2. Convert with an **explicit export filter**:

```bash
soffice --headless --convert-to 'docx:MS Word 2007 XML' --outdir <dir> file.html
```

Without the explicit filter (`--convert-to docx` on an HTML input) LibreOffice
fails with `Error: no export filter` — the filter name is mandatory here.

**Fast path — docx-js, only if actually installed:**

```bash
node -e "require('docx'); console.log('ok')"
```

If it prints `ok` (or `npm i docx` is acceptable), generate the document
programmatically — precise control of styles, tables, headers. If MODULE_NOT_FOUND
and no network, fall back to the HTML path. Do not fight the environment.

## Read

Extract text quickly (loses styling, keeps structure):

```bash
soffice --headless --convert-to txt --outdir <dir> file.docx
```

Read exact formatting: unzip and inspect the XML:

```bash
unzip -p file.docx word/document.xml          # body content
unzip -p file.docx word/styles.xml            # style definitions
unzip -l file.docx                            # full archive listing
```

`document.xml` is one long line — format it first (`python3 -c ...` with
`xml.dom.minidom`, or `xmllint --format` if present) before reading.

## Edit in place

Round-trip through the ZIP without LibreOffice:

```bash
mkdir _work && cd _work
unzip ../file.docx
# edit word/document.xml (and/or word/styles.xml)
zip -r -X ../file.docx . -x '.*'
cd .. && rm -rf _work
```

Rules:

- Edit with exact string replacements, never rewrite the whole
  `document.xml` from scratch.
- Preserve `[Content_Types].xml` and all `_rels/` files untouched.
- Text lives inside `<w:t>` elements; runs are `<w:r>`. To merge split runs
  (identical formatting chopped into pieces), collapse `<w:r>...<w:r>` into
  the first run keeping its `<w:rPr>`.
- Never leave the archive corrupted: after zipping, validate with
  `unzip -t file.docx` and re-open via the verify step below.

## Verify — mandatory before declaring done

```bash
soffice --headless --convert-to pdf --outdir <dir> file.docx
soffice --headless --convert-to png --outdir <dir> file.pdf   # FIRST page only
```

- `png` from `pdf` goes through LibreOffice Draw and renders **only page 1**.
  Adequate for title-page / first-page checks (font, margins, layout).
- For multi-page content: check page count (`pdfinfo` if present) and convert
  the docx to `txt` to confirm all text landed; state honestly that full visual
  verification of later pages was not possible on this machine.
- `magick file.pdf out.png` works **only** when Ghostscript is installed —
  without `gs` ImageMagick cannot decode PDF at all. Probe with `command -v gs`
  before relying on it.

## Gotchas

- `--convert-to docx` from HTML needs the explicit `docx:MS Word 2007 XML`
  filter; docx→pdf does not (its filter `writer_pdf_Export` resolves
  automatically).
- LibreOffice runs a per-user profile; concurrent headless runs clash — if a
  conversion hangs or silently no-ops, add a fresh profile:
  `-env:UserInstallation=file:///tmp/lo_$(date +%s)`.
- Fonts: output renders with fonts installed on the host. Times New Roman may
  map to Liberation Serif metrically-equivalent fallback — layout stays, exact
  glyphs may differ. Check with `fc-match "Times New Roman"` if font identity
  matters.
- Keep working files out of the deliverable: convert into a scratch dir, keep
  only the final `.docx` (and requested derivatives) where the user expects it.
