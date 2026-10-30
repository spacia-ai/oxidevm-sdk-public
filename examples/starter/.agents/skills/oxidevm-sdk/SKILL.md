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

## Author a custom image only when needed

Generated starters do not include an `image/` directory. Read the project's `README.md` for release-pinned recipe and custom-image guide links. Read `LICENSES.md` for the selected image's separately versioned source and license materials. For an older project without those links, read the installed SDK package version and use `https://github.com/spacia-ai/oxidevm-sdk-public/tree/v<VERSION>/examples/starter/image` and `https://github.com/spacia-ai/oxidevm-sdk-public/blob/v<VERSION>/docs/images.md`. Replace `<VERSION>` with that exact version. Do not substitute `main` or assume an unpublished tag exists.

Inspect the recipe and its source locks before proposing files or dependencies. Source/license archives are not rootfs or OCI base images. The default pandas recipe requires a separately supplied hash-pinned Python base and independent author trust. If these inputs are unavailable, report that prerequisite and use the guide's author-owned image workflow when requested. Do not invent a `requirements.lock` or claim a directory exists without checking it.

Use the project's matching CLI for image initialization, signing and build commands. Add a smoke test for the actual new program. The current `image test` harness requires the matching local engine; report that test as blocked if it is unavailable. A Docker build alone does not prove browser compatibility. Keep `runtime: { hosting: "frame" }` in the app. For image-only staging, use the guide's `installProjectAssets` example with `hosting: "frame"`; bare `assets install` also selects local engine installation. Preserve explicit image references, independent author trust, project locks and saved-workspace migration. Sharing an image requires complete license/source materials and distribution checks; a development signature is insufficient.

## Use the VM

Create the VM once for its application lifetime. Reuse it across actions. Dispose it when its owner is removed. Do not recreate it for every button click.

Use the workspace API for host-to-guest files. A host source file and `/workspace` inside Linux are different filesystems. For an upload, validate the filename, type and byte limit before writing bytes to the guest workspace.

Use `vm.exec` for bounded commands and the installed SDK's process or terminal APIs for longer-lived programs. Check the exit discriminant before reading an exit code. Decode output bytes explicitly. Keep cancellation, output limits, terminal resize and cleanup.

Render guest output as text. Keep previews in the SDK's isolated preview frame. Do not inject guest HTML into the host application's DOM or proxy guest execution to a server.

Run the application's type check, production build and the affected browser interaction. Preserve its package manager and unrelated files. Report unavailable capabilities through their typed SDK errors.

For API details, use the installed declarations and [OxideVM documentation](https://oxidevm.dev/docs/). Match documentation to the installed SDK before adopting a new API. Engine and guest licenses remain separate from the Apache-2.0 SDK and skills.
