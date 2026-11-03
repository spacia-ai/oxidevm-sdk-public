---
name: oxidevm-sdk
description: Build or change browser applications that use the OxideVM TypeScript SDK to run Linux programs, manage VM files and processes, or embed terminals and previews.
license: Apache-2.0
---

# Build with the OxideVM SDK

Read the application's `package.json`, lockfile, existing OxideVM configuration and installed `@oxidevm/sdk` declarations first. Use the installed version's public exports. A newer plugin does not upgrade the application's SDK or make newer APIs available.

## Choose the application boundary

- The host web application owns UI, uploads, charts and user actions. Linux programs and their files run inside the browser VM. The computer's development server serves the host application.
- Import application APIs from `@oxidevm/sdk`. Use `@oxidevm/sdk/image-builder` only in Node tooling. Machine and diagnostics APIs have their own public exports. Do not import SDK worker implementation paths.
- Keep the configured mode explicit. Userspace uses `mode: "userspace"`; System requires the developer's kernel and image. Preserve the selected mode and image rather than silently switching them.
- Normal starter development and production use `runtime: { hosting: "frame" }` and the pinned hosted runtime at `https://run.oxidevm.dev`. Preserve generated image references and independent author trust. Local engine installation is an explicit licensed self-hosting choice.
- Keep cross-origin isolation headers and the required iframe policy. Reuse the generated Vite configuration, preview host and asset helpers.

## Upgrade the SDK

`oxidevm.lock.json` binds one release: SDK and CLI version, engine release, image and staging paths. Update `@oxidevm/sdk` and `@oxidevm/cli` together to the same version. In SDK 0.0.10 and later, `assets install` refuses a lock from another release and names the differing fields; then run `npx oxidevm assets install --update-lock` with the options the project stages with (`--config`, `--engine-dir`, `--reference`), and pass `--image <bundle> --trust <author.public.json>` again for an image the project configuration does not name. It stages and verifies the new assets before it rewrites the lock in one step, and a failed run keeps the old lock. Review and commit the lock with the package update, then run `npx oxidevm doctor`; its `lock` check must pass. Do not edit the lock by hand.

## Author a custom image only when needed

Generated starters do not include an `image/` directory. Read the project's `README.md` for release-pinned recipe and custom-image guide links. Read `LICENSES.md` for the selected image's separately versioned source and license materials. For an older project without those links, read the installed SDK package version and use `https://github.com/spacia-ai/oxidevm-sdk-public/tree/v<VERSION>/examples/starter/image` and `https://github.com/spacia-ai/oxidevm-sdk-public/blob/v<VERSION>/docs/images.md`. Replace `<VERSION>` with that exact version. Do not substitute `main` or assume an unpublished tag exists.

Inspect the recipe and its source locks before proposing files or dependencies. Source/license archives are not rootfs or OCI base images. The default pandas recipe requires a separately supplied hash-pinned Python base and independent author trust. If these inputs are unavailable, report that prerequisite and use the guide's author-owned image workflow when requested. Do not invent a `requirements.lock` or claim a directory exists without checking it.

Use the project's matching CLI for image initialization, signing and build commands. Add a smoke test for the actual new program. The current `image test` harness requires the matching local engine; report that test as blocked if it is unavailable. A Docker build alone does not prove browser compatibility. Keep `runtime: { hosting: "frame" }` in the app. For image-only staging, use the guide's `installProjectAssets` example with `hosting: "frame"`; bare `assets install` also selects local engine installation. Preserve explicit image references, independent author trust, project locks and saved-workspace migration. Sharing an image requires complete license/source materials and distribution checks; a development signature is insufficient.

## Use a WebAssembly module

Applications can install packaged WebAssembly programs with `oxidevm wasm add`, but only an SDK release that exports `@oxidevm/sdk/wasm` supports it. Check the installed exports first; if they are missing, report that instead of adding modules by hand. In SDK 0.0.10 and later, modules run in the hosted runtime frame as well as self-hosted, on a cross-origin isolated page in Chromium or Firefox (WebKit and Safari refuse them), and their code runs in a per-VM module frame with an opaque origin. Self-hosted, `oxidevm assets install` stages that frame at `module-frame/` beside the engine assets; rerun it after every SDK upgrade, serve it with the headers in its `frame.json`, never let a Service Worker answer it, and allow its origin in the page's `frame-src`. When they are present, follow the `oxidevm-module-author` skill: review what a module declares before installing it, keep generated files untouched, and start modules with the typed handle and `spawnModule`. When the installed `@oxidevm/sdk/wasm` exports `enableModuleCommands`, a module's declared commands can be turned on per VM, and programs in the VM then run them from `/usr/local/bin`; keep `/usr/local/bin` before `/usr/bin` on a terminal's `PATH`.

A module whose card shows internet reach (`net.internet`) reaches the internet only after the application connects the VM through a relay with `vm.network.connect(...)` and the user allows the session; until then its requests fail as offline (`EPERM`), and a revoke resets them. Connect the VM only when the user wants internet access; for a personal relay, watch `vm.network` and show the pairing code. Disclosed hosts on the card are information, not an allowlist.

## Use the VM

Create the VM once for its application lifetime. Reuse it across actions. Dispose it when its owner is removed. Do not recreate it for every button click.

Use the workspace API for host-to-guest files. A host source file and `/workspace` inside Linux are different filesystems. For an upload, validate the filename, type and byte limit before writing bytes to the guest workspace.

Use `vm.exec` for bounded commands and the installed SDK's process or terminal APIs for longer-lived programs. Check the exit discriminant before reading an exit code. Decode output bytes explicitly. Keep cancellation, output limits, terminal resize and cleanup.

Render guest output as text. Keep previews in the SDK's isolated preview frame. Do not inject guest HTML into the host application's DOM or proxy guest execution to a server.

Run the application's type check, production build and the affected browser interaction. Preserve its package manager and unrelated files. Report unavailable capabilities through their typed SDK errors.

For API details, use the installed declarations and [OxideVM documentation](https://oxidevm.dev/docs/). Match documentation to the installed SDK before adopting a new API. Engine and guest licenses remain separate from the Apache-2.0 SDK and skills.
