---
name: oxidevm-module-author
description: Create, change, test or release an OxideVM WebAssembly module, a repository that packages a WebAssembly program with a typed manifest and adapter for `oxidevm wasm add`, or install such a module into an application.
license: Apache-2.0
---

# Author or install an OxideVM WebAssembly module

A module wraps a WebAssembly program so an application installs it with one command and runs it next to real Linux programs. Read the project's `package.json`, lockfile and the installed `@oxidevm/sdk` and `@oxidevm/cli` declarations first. A newer plugin does not upgrade the project's SDK.

## Check the prerequisite

Modules exist only in SDK releases that export `@oxidevm/sdk/wasm` and whose CLI has `oxidevm wasm --help`. Confirm both in the installed packages before writing anything. If either is missing, stop and report that prerequisite; do not copy APIs from another version or invent a substitute.

Module commands (a `commands` list in the manifest, `enableModuleCommands`, the `process.signals` capability, `io.invocation` and `io.terminals`) exist only in SDK releases whose `@oxidevm/sdk/wasm` exports `enableModuleCommands` (Userspace API 145). Check that export before declaring or turning on commands; an older SDK refuses a module that declares them.

Modules start Userspace JS processes, so an application runs them only on a self-hosted runtime and a cross-origin isolated page. Report that limit instead of working around it.

## Write a module

- Work in the module's own repository. Create one with `oxidevm wasm init <directory> [--kind command|service] [--from file.wasm]`; it never overwrites existing files. Run `oxidevm wasm inspect <file.wasm>` first to learn which ABI a binary appears to use. Read the generated `AGENTS.md` and README.
- Edit only `module.ts`, `src/` and `test/`. Never edit `dist/`, a lockfile or anything an `oxidevm wasm` command generated. Do not add `.oxidevm` files to a project that is not a module.
- Keep `manifest` a literal object: the build reads it without running code, so it cannot use variables, calls or spreads. Declare in `requires.host` only the host operations the adapter uses; its `host` has exactly those members and the compiler enforces it. A service's `protocols` keys equal its `expose` keys.
- The adapter is a factory `host => hooks`. Keep state in its closure. Import types from `@oxidevm/sdk/wasm` with `import type`; the one runtime import is `defineModule`. Use `host.kit` for errno mapping, framing, session gates, native commands and atomic directories instead of rewriting them. Use `host.artifacts` for the WebAssembly files; never fetch code at run time.
- Strict types: no `any`, no suppressions, no unchecked assertions. Treat arguments, bytes and WebAssembly exports as `unknown` until checked.
- A command module may declare `commands: ["<name>"]`: names only (lower-case letters, digits, `.`, `_`, `+` and `-`, at most 64 characters, not starting with `oxidevm`, at most 16 names). Once an application turns them on, each runs as `/usr/local/bin/<name>` and can take the place of an image program with the same name. Adding a name later makes every application consent again. Never list your own command in `requires.guest.executables`.
- A command that a program in the VM runs gets that program's arguments, environment, directory and standard streams. Name it with `io.invocation.argv0`; `io.args` never holds argv[0]. Standard input may be a terminal, a pipe, a file or empty: read it only when the interface says so, and until an empty read. Use colour or prompts only when `io.terminals` says the stream is a terminal. Return 0 to 119, and 2 for usage errors; never throw for a user's mistake, because a throw is status 123. Every run starts a fresh process, so keep start-up cheap.
- A signal ends a command at once, and `close()` does not run. To handle Ctrl+C or SIGTERM, declare `process.signals` and call `host.process.signals.trap([...])`; finish quickly, then `untrap()` and `raise()` the signal so a shell loop stops.

## Verify before claiming anything

Run, in order, and report each result: `pnpm run check` (types, lint, and `oxidevm wasm build --check`), `pnpm test`, `oxidevm wasm build`, then `oxidevm wasm test` (the runner's rules checked in a real browser; give a command's arguments with `--arg`). A failed build exits 3 and lists findings with file and line; fix errors, and read warnings (dependency code that mentions `window`, `import.meta` or `eval`; imports replaced with empty modules; a bundled package the license does not name). A failed `wasm test` property also exits 3 and says why; `declared-host` failing means the adapter reached for a host member `requires.host` does not declare. If `oxidevm wasm --help` does not list `wasm test`, the installed CLI predates it: skip it and say so.

Unit tests, a successful build and `oxidevm wasm test` do not prove a module does its job. Only running it in a browser on a self-hosted runtime does: through `spawnModule`, and for a module with commands also from a shell in the VM after `enableModuleCommands`. If that was not run, say the module is unverified at run time.

## Upstream code and licenses

Mirror upstream WebAssembly byte for byte. Record where each file came from, its version and its sha256, and re-check the hash when fetching. Never edit a third-party binary. Keep every license and notice. State an accurate SPDX expression in `license.spdx`; a copyleft module needs `license.source` and a notices artifact named in `license.notices`. Do not invent or alter licenses and do not state a license you have not read.

## Release

Release by tag only: `oxidevm wasm release` builds and prints the steps (tag `v<version>`, draft, download and `sha256sum --check SHA256SUMS`, publish). Do not run the tagging, pushing, `gh release` or publishing commands yourself unless the user asks for that exact action. Never replace a published tag or release asset.

## Install a module in an application

Run `oxidevm wasm add <github:owner/repo@tag | file:directory>` and read the card it prints: host operations, browser features, guest executables, endpoints, files it writes and license. A `file:` directory must be inside the project. Do not pass `--yes` for a module nobody has reviewed. Commit `oxidevm.modules.json`, `oxidevm.modules.lock.json` and `modules/<id>/module.json`; do not edit or commit `.oxidevm/modules/` or `src/oxidevm.modules.generated.ts`. Start a module with `spawnModule(vm, handle, options)` from `@oxidevm/sdk/wasm`; options and endpoints are typed by its manifest. Stop modules with `stopModule` before capturing a restore point. A running module uses one JS process, and at most 32 host commands run at once.

Installing never turns a module's commands on. Turn them on per VM with `enableModuleCommands(vm, handle, { commands?, options?, concurrency? })`; each command run is one JS process too, and `concurrency` (default 4) limits how many runs of that module are active at once. The card lists each command, its path and what it can shadow. A shell finds the commands only when `PATH` lists `/usr/local/bin` before `/usr/bin`. Their files are checked once, when they are turned on, so turn them off and on again to pick up a new release. After `disable()` a command is gone; a stub left by an earlier session exits 126 until the application turns its commands on again. A module that runs code it is given, such as a Python interpreter, lets every program in the VM run code in the page's origin through it: turn such commands on only where that is acceptable. An adapter is code that runs with the authority it declares; it is not a sandbox.

For details use the installed declarations and the [OxideVM documentation](https://oxidevm.dev/docs/), matching them to the installed SDK version. Engine and guest licenses remain separate from the Apache-2.0 SDK and skills.
