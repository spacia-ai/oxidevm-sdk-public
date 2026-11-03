---
name: oxidevm-module-author
description: Create, change, test or release an OxideVM WebAssembly module, a repository that packages a WebAssembly program with a typed manifest and adapter for `oxidevm wasm add`, declare its network reach, or install such a module into an application.
license: Apache-2.0
---

# Author or install an OxideVM WebAssembly module

A module wraps a WebAssembly program so an application installs it with one command and runs it next to real Linux programs. Read the project's `package.json`, lockfile and the installed `@oxidevm/sdk` and `@oxidevm/cli` declarations first. A newer plugin does not upgrade the project's SDK.

## Check the prerequisite

Modules exist only in SDK releases that export `@oxidevm/sdk/wasm` and whose CLI has `oxidevm wasm --help`. Confirm both in the installed packages before writing anything. If either is missing, stop and report that prerequisite; do not copy APIs from another version or invent a substitute.

Module commands (a `commands` list in the manifest, `enableModuleCommands`, the `process.signals` capability, `io.invocation` and `io.terminals`) exist only in SDK releases whose `@oxidevm/sdk/wasm` exports `enableModuleCommands` (Userspace API 145). Check that export before declaring or turning on commands; an older SDK refuses a module that declares them.

The networking standard (`net.vm`, `net.internet`, `network`, `host.net`, `kit.emscripten.network`, `kit.tls`, `kit.net.describe`, `MODULE_EXIT`), `@oxidevm/sdk/wasm/testing`, signal masks and real-time signals, `oxidevm wasm init --network` and the `network-*` properties of `oxidevm wasm test` need SDK and CLI 0.0.10 or later (Userspace API 146). Check the installed version and declarations before using any of them; with an older SDK, follow what that SDK documents and say the rest is unavailable.

## Where modules run

Modules start Userspace JS processes of a VM that `createVM` made, self-hosted or in the hosted runtime frame, on a cross-origin isolated page. Module code never runs in the page's origin: each VM has a sandboxed **module frame** with an opaque origin and no network of its own. So module code has no access to the page's cookies, IndexedDB, OPFS, CacheStorage, Web Locks or BroadcastChannels; in Chromium `crypto.subtle` is unavailable (`crypto.getRandomValues` remains). Do not name `indexeddb` or `web-locks` in `requires.browser`: such a module cannot start (`wasm-module-prerequisite`). Modules run in Chromium and Firefox; WebKit and Safari refuse them with `FEATURE_NOT_AVAILABLE` `wasm-module-isolation-unavailable`. Report these limits instead of working around them; nothing falls back to the page's origin.

Each VM checks each pinned file once, before any module code runs, and keeps the checked copy (WebAssembly compiled once) for every later start and command run in that VM. A mismatch rejects with `wasm-module-integrity` before a process exists. `host.artifacts.url(name)` is a `blob:` URL of that checked copy.

## Write a module

- Work in the module's own repository. Create one with `oxidevm wasm init <directory> [--kind command|service] [--from file.wasm]`; it never overwrites existing files. Run `oxidevm wasm inspect <file.wasm>` first to learn which ABI a binary appears to use. Read the generated `AGENTS.md` and README.
- Edit only `module.ts`, `src/` and `test/`. Never edit `dist/`, a lockfile or anything an `oxidevm wasm` command generated. Do not add `.oxidevm` files to a project that is not a module.
- Keep `manifest` a literal object: the build reads it without running code, so it cannot use variables, calls or spreads. Declare in `requires.host` only the host operations the adapter uses; its `host` has exactly those members and the compiler enforces it. A service's `protocols` keys equal its `expose` keys.
- The adapter is a factory `host => hooks`. Keep state in its closure. Import types from `@oxidevm/sdk/wasm` with `import type`; the one runtime import is `defineModule`. Use `host.kit` for errno mapping, framing, session gates, native commands and atomic directories instead of rewriting them. Use `host.artifacts` for the WebAssembly files; never fetch code at run time.
- Strict types: no `any`, no suppressions, no unchecked assertions. Treat arguments, bytes and WebAssembly exports as `unknown` until checked.
- Never use the browser's own network or storage from module code. `XMLHttpRequest`, `EventSource`, `sendBeacon`, `RTCPeerConnection`, `WebTransport` and `import()`/`importScripts` of anything but a blob do not work in a module worker.
- A command module may declare `commands: ["<name>"]`: names only (lower-case letters, digits, `.`, `_`, `+` and `-`, at most 64 characters, not starting with `oxidevm`, at most 16 names). Once an application turns them on, each runs as `/usr/local/bin/<name>` and can take the place of an image program with the same name. Adding a name later makes every application consent again. Never list your own command in `requires.guest.executables`.
- A command that a program in the VM runs gets that program's arguments, environment, directory and standard streams. Name it with `io.invocation.argv0`; `io.args` never holds argv[0]. Standard input may be a terminal, a pipe, a file or empty: read it only when the interface says so, and until an empty read. Use colour or prompts only when `io.terminals` says the stream is a terminal. Return 0 to 119, and 2 for usage errors; never throw for a user's mistake, because a throw is status 123. Every run starts a fresh process, so keep start-up cheap.
- A signal ends a command at once, and `close()` does not run. To handle Ctrl+C or SIGTERM, declare `process.signals` and call `host.process.signals.trap([...])`; finish quickly, then `untrap()` and `raise()` the signal so a shell loop stops.
- `trap` also takes the real-time signals by name (`SIGRTMIN`, `SIGRTMIN+n`, `SIGRTMAX-n`, `SIGRTMAX`) or number (35 to 64); each arrives as `{ signal, value, code, pid, uid }`, and every `sigqueue` value queues in order. `block(signals)` and `unblock(signals)` change the signal mask like `sigprocmask` and resolve with the previous mask; a blocked signal stays in `pending()` and is delivered once when unblocked. A module inherits its starter's mask, so one started from a shell that blocks SIGINT sees no Ctrl+C until it unblocks it. SIGKILL and SIGSTOP can never be trapped or blocked.

## Network reach

Every module declares how far it reaches, and the engine holds each of its processes to that (ADR 0029). Choose the smallest reach:

- **none** (no reach token, the default): no connections of its own; `fetch` and `WebSocket` fail with "network not declared". A service still serves programs in the VM through `expose`.
- **`net.vm`**: programs in this VM only (loopback, Unix sockets, the VM's own addresses; names from `/etc/hosts`).
- **`net.internet`** (includes VM-only): also public hosts on TCP 80 and 443, plus DNS, through the VM's relay connection.

Name at most one token. `sockets.connect` needs one of them; the build refuses it alone. With `net.internet` a module may add `network: { hosts?, purpose? }` (up to 32 DNS names, a leading `*.` allowed, and one sentence of up to 200 characters). It is disclosure for the install card and `oxidevm wasm doctor`, never an allowlist: do not describe it as a restriction. `network` without `net.internet` is invalid.

A module with a reach gets `fetch`, `Request`, `Response`, `Headers` and `WebSocket` on its own VM sockets, and `host.net` (`resolve`, `connect({ host, port, tls, alpn })`, blocking `resolveSync`/`connectSync` for interpreters that cannot await, and `tls()`). TLS runs inside the module against the VM's trust store `/etc/ssl/cert.pem`; nothing switches verification off. `fetch` follows Node's semantics (no CORS). Adapt a program's own network layer with the kit instead of rewriting it: `host.kit.emscripten.network(host, Module)` for Emscripten SOCKFS and `getaddrinfo` (export `SOCKFS`, `DNS` and `FS`; listening sockets get `EOPNOTSUPP`), and `host.net.connect({ tls: true })` or `host.kit.tls` for a program without TLS. WASI preview 1 has no sockets; use `fetch` or `host.net` in the glue. Credentials come only from options or guest files.

Offline is the normal case: the VM is local-only until the application connects it, so an internet module gets `EPERM` (`vm-local-only`) until then, `ECONNRESET` after a revoke, and `EACCES` (`module-network-reach`) beyond its reach. `fetch` rejects with `TypeError("fetch failed")` whose `cause` is a `NetError`. Pass `host.signal` (or `AbortSignal.any` with a timeout) to every request and bound every body. On a network failure a command prints one line from `host.kit.net.describe(error, argv0)` and returns 69, `MODULE_EXIT.unavailable` (write the number in the adapter, use the constant in tests); a service fails only that request and stays ready. Never retry in a loop.

Give the module's README a "Network" section: the reach, the disclosed hosts and purpose, and what happens offline. `oxidevm wasm init --network none|vm|internet` generates the declaration, that section, `AGENTS.md` rules and tests (`src/net.ts` for `vm` and `internet`). Browser runs of a module's internet HTTPS `fetch` and `wss` through a relay pass in Chromium and Firefox, with the runtime self-hosted and in the hosted runtime frame: TLS verified against the VM's trust store, DNS through the VM's resolver, and a relay-side revoke or `vm.network.disconnect()` during a download ending it with `ECONNRESET`. Those runs used a relay test peer and a throwaway test CA, not live internet or a real personal relay's control page. The personal relay lists the destinations a session reached on its control page from relay 0.2.0, released with SDK 0.0.10. WebKit and Safari refuse modules. Claim no more than that, and say whether your own module was run in a browser.

## Verify before claiming anything

Write unit tests with `testHost(definition, inputs)` from `@oxidevm/sdk/wasm/testing`: it runs the module through the SDK's real runner without a browser and resolves `run()` with `status`, `stdout`, `stderr`, `files` and the ending `signal`. Inputs are `args`, `env`, `cwd`, `invocation`, `terminals`, `stdin`, `files`, `options`, `artifacts` and `net`; the network is local-only unless `net.connected` is set, then `net.http` handlers serve by origin and `net.vm` handlers by port, with the browser's reach checks and errors. Test the offline path as well as the connected one.

Run, in order, and report each result: `pnpm run check` (types, lint, and `oxidevm wasm build --check`), `pnpm test`, `oxidevm wasm build`, then `oxidevm wasm test` (the runner's rules checked in a real browser; give a command's arguments with `--arg`). A failed build exits 3 and lists findings with file and line; fix errors, and read warnings (dependency code that mentions `window`, `import.meta` or `eval`; imports replaced with empty modules; a bundled package the license does not name; `adapter-network` for a browser network API). A failed `wasm test` property also exits 3 and says why: `declared-host` means the adapter reached for a host member `requires.host` does not declare, `network-direct` that it used a browser network API, `network-declared` that it connected beyond its reach, and `network-offline` that, with the VM local-only, a command did not end with 0 to 119 and a line on standard error, or a service did not stay ready. If `oxidevm wasm --help` does not list `wasm test`, the installed CLI predates it: skip it and say so.

Unit tests, a successful build and `oxidevm wasm test` do not prove a module does its job. Only running it in a browser does: through `spawnModule`, and for a module with commands also from a shell in the VM after `enableModuleCommands`. If that was not run, say the module is unverified at run time.

## Upstream code and licenses

Mirror upstream WebAssembly byte for byte. Record where each file came from, its version and its sha256, and re-check the hash when fetching. Never edit a third-party binary. Keep every license and notice. State an accurate SPDX expression in `license.spdx`; a copyleft module needs `license.source` and a notices artifact named in `license.notices`. Do not invent or alter licenses and do not state a license you have not read.

## Release

Release by tag only: `oxidevm wasm release` builds and prints the steps (tag `v<version>`, draft, download and `sha256sum --check SHA256SUMS`, publish). Do not run the tagging, pushing, `gh release` or publishing commands yourself unless the user asks for that exact action. Never replace a published tag or release asset.

## Install a module in an application

Run `oxidevm wasm add <github:owner/repo@tag | file:directory>` and read the card it prints: host operations, browser features, guest executables, endpoints, files it writes and license. A `file:` directory must be inside the project. Do not pass `--yes` for a module nobody has reviewed. Commit `oxidevm.modules.json`, `oxidevm.modules.lock.json` and `modules/<id>/module.json`; do not edit or commit `.oxidevm/modules/` or `src/oxidevm.modules.generated.ts`. Start a module with `spawnModule(vm, handle, options)` from `@oxidevm/sdk/wasm`; options and endpoints are typed by its manifest. Stop modules with `stopModule` before capturing a restore point. A running module uses one JS process, and at most 32 host commands run at once.

Installing never turns a module's commands on. Turn them on per VM with `enableModuleCommands(vm, handle, { commands?, options?, concurrency? })`; each command run is one JS process too, and `concurrency` (default 4) limits how many runs of that module are active at once. The card lists each command, its path and what it can shadow. A shell finds the commands only when `PATH` lists `/usr/local/bin` before `/usr/bin`. The VM checks each file once and reuses the checked copy; a new VM, or a new release, checks again. After `disable()` a command is gone; a stub left by an earlier session exits 126 until the application turns its commands on again. A module that runs code it is given, such as a Python interpreter, lets every program in the VM run code in the page's origin through it: turn such commands on only where that is acceptable. An adapter is code that runs with the authority it declares; the module frame isolates it from the page's origin, but it is not a sandbox for the VM. An interpreter command also lends its network reach to every program that runs it.

A module with `net.internet` reaches the internet only after the application connects the VM through a relay (`vm.network.connect`) and the user allows the session; until then it gets `EPERM`. Programs it starts with `process.spawn` follow the VM's own network policy, not the module's reach. When a module's manifest names `sockets.connect` without a reach token (built by a CLI before 0.0.10), it has VM-only reach; rebuild it with `net.internet` to reach the internet.

For details use the installed declarations and the [OxideVM documentation](https://oxidevm.dev/docs/), matching them to the installed SDK version. Engine and guest licenses remain separate from the Apache-2.0 SDK and skills.
