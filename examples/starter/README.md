# Your Linux Python data starter

Edit Python on the left and inspect its pandas DataFrame on the right.
This Vite and TypeScript application runs the actual Linux x86-64 Python,
NumPy and pandas binaries through OxideVM Userspace. It does not boot a kernel.
Python executes in the browser's hosted runtime iframe. There is no data-processing backend.

## Start

Use Node.js 24 or newer:

```sh
npx @oxidevm/cli@latest init app --start
```

Or use Bun:

```sh
bunx --package @oxidevm/cli@latest oxidevm init app-bun --use-bun --start
```

For a fixed release, replace `@latest` with its exact version. The generated
project pins matching SDK and CLI versions.

The creator installs dependencies and starts Vite with `--start`.
Restart a generated application with `npm run dev` or `bun run dev`.
Use Node.js 24 or newer. Image building and compiler toolchains are not needed.

## Explore your data

The sample groups eight orders by country. Change `analysis.py` in the editor
and choose **Run code**, or press Ctrl/Command + Enter. Assign a pandas
DataFrame to `result`. The preview shows up to 200 rows and 64 columns, with
column types and the actual total row count. Cell values render as text.
The editor highlights Python syntax while preserving native text editing,
selection, undo, and the run shortcut.

Choose **Upload CSV** for a file up to 5 MiB. The original file is retained in
`uploads/` with a unique name. Its selected copy is `data.csv`. Python's real
`pd.read_csv` parses it. The unchanged sample script switches to a generic
preview for uploaded data. Custom Python code is preserved; adapt its column
names to the new CSV when needed. The data file tab previews its first 65,536
characters.

**Export CSV** downloads the result, with a 10 MiB limit. A failed or interrupted
run preserves the previous successful table. After an upload, export stays
disabled until the new dataset produces a result. Choose **Stop execution** to
interrupt a running script. Each run has a three-minute limit.

Python stays alive between runs and imports NumPy and pandas once. Script
globals start fresh each time. Imported module state remains in the session.
Stop execution, a Python process failure, or Reset demo restarts the interpreter.
The next run then imports the libraries again. Reloading the page also starts
a new interpreter.

The terminal shares the same Linux workspace. Try:

```sh
python3 -c 'import pandas, numpy; print(pandas.__version__, numpy.__version__)'
ls uploads
```

Code, the selected CSV and uploads persist when browser storage is available.
Browsers can reclaim local storage. Export important results. **Reset demo**
restores the sample code and CSV after confirmation; other files remain.

## Source layout

- `src/main.ts` connects controls, upload, persistence and rendering.
- `src/python.ts` executes Linux Python and validates its results.
- `src/analysis.ts` contains the sample and the guest Python result writer.
- `src/dataframe.ts` validates the bounded preview protocol.
- `src/terminal.ts` connects xterm to a real Linux PTY.

`src/image.ts` and `src/production-image.ts` pin the signed image. Both development
and production use `https://run.oxidevm.dev`. Normal initialization downloads
no local engine or image archive. The production build contains no proprietary
engine binaries. Explicit licensed self-hosting and custom images remain available.

## Licenses and builds

`npm run build` or `bun run build` produces static application files.
The SDK, CLI and starter code use Apache-2.0. The engine has separate proprietary
terms. Python, NumPy, pandas, other guest libraries and fonts retain their own
licenses and notices. See [the licensing guide](../../docs/licensing.md).
The image recipe and exact dependency inputs live beside this example in `image/`.

NumPy is built without external BLAS/LAPACK and without bundled Fortran or
quadmath libraries. It uses its internal fallback routines. This starter
qualifies CSV/dataframe operations; it makes no numerical-performance claim.
