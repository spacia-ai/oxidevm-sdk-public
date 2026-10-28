# Your OxideVM starter

This small Vite and TypeScript app runs nginx, a Linux server, in your browser.
Edit the page, use a real shell, restart nginx, and keep edits across reloads.
The starter uses explicit Userspace mode and a signed image. It does not boot
a kernel. Browser storage has best-effort retention.

## Start development

The creator installs dependencies and starts Vite when you use `--start`.
To start the generated app again, run `npm run dev` or `bun run dev`.
If you omitted `--start`, install dependencies first with `npm install` or
`bun install`. Node.js 24 or newer is required.

## Make it yours

`src/main.ts` connects the SDK to the interface. `src/runtime.ts` selects the
hosted runtime for both development and production. `src/server.ts` owns nginx
configuration and process lifecycle. `src/page.ts` seeds the guest page.
`src/terminal.ts` connects xterm to a real guest PTY. The hosted preview service displays the Linux server.

nginx listens on guest port 8080. Edit HTML with **Edit this page**, then choose
**Save & reload**. Stop and restart nginx with the server controls. Reset
replaces only `site/index.html`, after confirmation.

`src/image.ts` and `src/production-image.ts` pin the same signed hosted image
by default. The browser downloads and verifies it. Image building belongs to
image maintainers. App users need no image paths or compiler toolchains.

## Deployment and licenses

`npm run build` or `bun run build` creates static files. Development and production
load the runtime through a hidden iframe on `https://run.oxidevm.dev`.
The creator installs no engine, image bundle, or compliance files in your
project. Wasm and the signed image load inside the browser. Both environments
use the hosted per-session preview service. The build does not copy engine
binaries into your deployment. Licensed self-hosting requires explicit
configuration and a commercial self-hosting agreement. `oxidevm init` with
`--engine-dir` selects an explicit local development runtime. Local custom
images can be staged with `--image` and `--image-trust` without installing an
engine. The runtime must be published for the pinned SDK version before the
hosted starter can run. It never falls back to a local engine.

The application code uses Apache-2.0. Engine use follows separate proprietary
terms. The image is a collection of separately licensed programs. Its materials
include notices, license texts, inventories, checksums, and corresponding
sources. Fonts keep their OFL notices in `public/fonts`.

## Source downloads

See [GPL sources and license materials](../../docs/licensing.md) for the exact
image source archives, rebuild instructions, notices, and checksums.

Changing an existing app from a local runtime to the hosted frame changes its
browser storage origin. Existing local data is not deleted or automatically
migrated. Export any workspace or backup you need before switching.
