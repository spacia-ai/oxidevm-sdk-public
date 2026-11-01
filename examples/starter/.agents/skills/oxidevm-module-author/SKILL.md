---
name: oxidevm-module-author
description: Create, change, test or release an OxideVM WebAssembly module, a repository that packages a WebAssembly program with a typed manifest and adapter for `oxidevm wasm add`, or install such a module into an application.
license: Apache-2.0
---

# Author or install an OxideVM WebAssembly module

A module wraps a WebAssembly program so an application installs it with one command and runs it next to real Linux programs. Read the project's `package.json`, lockfile and the installed `@oxidevm/sdk` and `@oxidevm/cli` declarations first. A newer plugin does not upgrade the project's SDK.

## Check the prerequisite

Modules exist only in SDK releases that export `@oxidevm/sdk/wasm` and whose CLI has `oxidevm wasm --help`. Confirm both in the installed packages before writing anything. If either is missing, stop and report that prerequisite; do not copy APIs from another version or invent a substitute.

Modules start Userspace JS processes, so an application runs them only on a self-hosted runtime and a cross-origin isolated page. Report that limit instead of working around it.

## Write a module

- Work in the module's own repository. Create one with `oxidevm wasm init <directory> [--kind command|service] [--from file.wasm]`; it never overwrites existing files. Run `oxidevm wasm inspect <file.wasm>` first to learn which ABI a binary appears to use. Read the generated `AGENTS.md` and README.
- Edit only `module.ts`, `src/` and `test/`. Never edit `dist/`, a lockfile or anything an `oxidevm wasm` command generated. Do not add `.oxidevm` files to a project that is not a module.
- Keep `manifest` a literal object: the build reads it without running code, so it cannot use variables, calls or spreads. Declare in `requires.host` only the host operations the adapter uses; its `host` has exactly those members and the compiler enforces it. A service's `protocols` keys equal its `expose` keys.
- The adapter is a factory `host => hooks`. Keep state in its closure. Import types from `@oxidevm/sdk/wasm` with `import type`; the one runtime import is `defineModule`. Use `host.kit` for errno mapping, framing, session gates, native commands and atomic directories instead of rewriting them. Use `host.artifacts` for the WebAssembly files; never fetch code at run time.
- Strict types: no `any`, no suppressions, no unchecked assertions. Treat arguments, bytes and WebAssembly exports as `unknown` until checked.

## Verify before claiming anything

Run, in order, and report each result: `pnpm run check` (types, lint, and `oxidevm wasm build --check`), `pnpm test`, `oxidevm wasm build`, then `oxidevm wasm test` (the runner's rules checked in a real browser; give a command's arguments with `--arg`). A failed build exits 3 and lists findings with file and line; fix errors, and read warnings (dependency code that mentions `window`, `import.meta` or `eval`; imports replaced with empty modules; a bundled package the license does not name). A failed `wasm test` property also exits 3 and says why; `declared-host` failing means the adapter reached for a host member `requires.host` does not declare. If `oxidevm wasm --help` does not list `wasm test`, the installed CLI predates it: skip it and say so.

Unit tests, a successful build and `oxidevm wasm test` do not prove a module does its job. Only running it through `spawnModule` on a self-hosted runtime in a browser does. If that was not run, say the module is unverified at run time.

## Upstream code and licenses

Mirror upstream WebAssembly byte for byte. Record where each file came from, its version and its sha256, and re-check the hash when fetching. Never edit a third-party binary. Keep every license and notice. State an accurate SPDX expression in `license.spdx`; a copyleft module needs `license.source` and a notices artifact named in `license.notices`. Do not invent or alter licenses and do not state a license you have not read.

## Release

Release by tag only: `oxidevm wasm release` builds and prints the steps (tag `v<version>`, draft, download and `sha256sum --check SHA256SUMS`, publish). Do not run the tagging, pushing, `gh release` or publishing commands yourself unless the user asks for that exact action. Never replace a published tag or release asset.

## Install a module in an application

Run `oxidevm wasm add <github:owner/repo@tag | file:directory>` and read the card it prints: host operations, browser features, guest executables, endpoints, files it writes and license. A `file:` directory must be inside the project. Do not pass `--yes` for a module nobody has reviewed. Commit `oxidevm.modules.json`, `oxidevm.modules.lock.json` and `modules/<id>/module.json`; do not edit or commit `.oxidevm/modules/` or `src/oxidevm.modules.generated.ts`. Start a module with `spawnModule(vm, handle, options)` from `@oxidevm/sdk/wasm`; options and endpoints are typed by its manifest. Stop modules with `stopModule` before capturing a restore point. A running module uses one JS process, and at most 32 host commands run at once. An adapter is code that runs with the authority it declares; it is not a sandbox.

For details use the installed declarations and the [OxideVM documentation](https://oxidevm.dev/docs/), matching them to the installed SDK version. Engine and guest licenses remain separate from the Apache-2.0 SDK and skills.
