---
name: oxidevm-starter
description: Extend an OxideVM generated starter with Linux Python and pandas, CSV upload, a DataFrame preview, charts, editing or terminal interactions.
license: Apache-2.0
---

# Extend the OxideVM data starter

Read `AGENT_SKILLS.json` when present, `package.json`, `src/main.ts`, `src/analysis.ts`, `src/python.ts`, and the existing tests before changing the starter. Use the installed SDK declarations for APIs. Treat these file names as the generated layout, not a requirement to replace an existing application's structure.

## Preserve the demonstration

The starter demonstrates real Linux x86-64 Python, NumPy and pandas inside the browser. Keep calculations in that Linux process. Do not replace them with JavaScript data processing, Pyodide, a mock result or remote compute.

The host application owns the code editor, CSV upload and DataFrame display. The guest workspace owns uploaded CSV files and Python execution. Keep these boundaries explicit when adding a feature.

Keep the Python session alive between runs. Reuse its result protocol and bounded DataFrame decoder. A chart can render the decoded result in the host page without recomputing the pandas operation in JavaScript. Keep table and CSV export based on the same completed result.

For a request such as “add a revenue chart,” inspect the existing render function and its caller. Add the chart to that result path. Handle an empty result, missing columns and non-numeric values. Use existing components or browser APIs before adding a chart dependency.

## Change guest packages only through an explicit image workflow

Generated starters do not include an `image/` directory. Read `README.md` for release-pinned recipe and custom-image guide links. Read `LICENSES.md` for the image's own source and license release. Inspect the actual Dockerfile, locks and build instructions before proposing a recipe. Host npm packages do not install Linux programs. Do not invent missing files or assume a source archive is a runnable rootfs.

The default recipe builds NumPy and pandas from pinned sources and needs a separately supplied exact Python base plus independent author trust. Missing base inputs block that rebuild. The custom-image guide also covers creating an author-owned image, keys, build and smoke tests, immutable hosting, explicit image references and lock updates. Keep the app on `runtime: { hosting: "frame" }`. Follow the guide's image-only staging path rather than installing an engine implicitly. Update both development and production references when requested; preserve the old pins and workspace data for rollback. Do not infer package compatibility from a successful Docker build or reuse distribution approval after changing dependencies.

## Keep the app usable

- Preserve Python syntax highlighting, CSV selection and upload limits, cancellation, errors and keyboard execution.
- Preserve the Linux terminal, resize, interrupts, persistent edits and the reset confirmation. Do not reset data to make a test pass.
- Avoid stale results after an upload or failed run. Keep export availability tied to the current dataset and completed result.
- Render uploaded values and program output as text. Do not create HTML from CSV contents.
- Keep the real OxideVM logo, current colors and the clear starter/demo label. Put setup guidance outside the Linux terminal and workbench.

Run the project type check, production build and focused tests. In the browser, run the sample, upload a small custom CSV, edit the analysis and verify the new result. Explain any browser or image test that could not run.

See the [starter quickstart](https://oxidevm.dev/docs/start/quickstart/). Project skills work in Codex and Claude Code when the client can read this folder. Regular desktop chat does not gain access to local files merely because the browser demo is open.
