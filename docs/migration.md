# SDK migration

## Explicit image projects

`ProjectConfig` accepts an optional `image` location, manifest SHA-256, and author
trust key. Its mode must match the project. The project lock records this exact
image and rejects later changes without an explicit project update.

Application initialization accepts `--image <bundle> --image-trust <file>`.
Both options are required together. Asset installation accepts
`--image <bundle> --trust <file>` and preserves existing project locks.

A newly installed custom image now becomes the project's image lock. Earlier
development builds could stage a custom image while locking the managed
default instead. Recreate that development lock from the explicitly selected
image before updating its assets. The installer never replaces a conflicting
existing lock silently.

Release catalog schema 3 describes a release with no managed images and no
managed kernel integration. Schema 2 remains supported for existing private
releases. A release with no configured default returns `FEATURE_NOT_AVAILABLE`
when a caller requests one. Supply an image explicitly in these releases.

## Version and runtime identity

SDK packages, CLI packages, embedded SDK version, and catalog version belong to
the same release. Update them together. The CLI archive must depend exactly on
the matching SDK version.

A hosted runtime frame also uses the SDK version in its URL and handshake.
Building a package does not deploy that hosted frame. Private qualification
serves matching assets through a browser fixture without deployment.

Project locks bind the SDK version, engine release, image, and staging paths.
Updating a dependency alone does not migrate a project lock: follow
[Upgrade the SDK](#upgrade-the-sdk), which stages and verifies the replacement
release and image before it rewrites the lock.

Restore point formats and runtime support remain experimental. A package
version change does not establish snapshot compatibility or runtime GA.

## Upgrade the SDK

`oxidevm.lock.json` binds one release: the SDK and CLI version, the engine
release, the image and the staging paths. After an upgrade,
`oxidevm assets install` (the starter's `npm run assets`) refuses the old lock
and says what differs and how to update it:

```text
INVALID_ARGUMENT: project lock oxidevm.lock.json does not match the installed SDK release and project configuration (differing fields: sdkVersion, cliVersion, engine, engineRelease): locked SDK 0.0.9, engine sha256:<old engine>, image sha256:<image>; installed SDK 0.0.10, engine sha256:<new engine>, image sha256:<image>; run `npx oxidevm assets install --update-lock` to stage this release's assets and rewrite the lock (pass --image and --trust again for an image the project configuration does not name)
```

1. Update `@oxidevm/sdk` and `@oxidevm/cli` together, to the same version:
   `npm install @oxidevm/sdk@<version>` and
   `npm install --save-dev @oxidevm/cli@<version>` (`pnpm add` or `bun add`
   likewise).
2. Run `npx oxidevm assets install --update-lock` with the options you stage
   with, such as `--config`, `--engine-dir` or `--reference`. The old lock never
   vouches for an image: for an image that the project configuration does not
   name, pass `--image <bundle> --trust <author.public.json>` again.
   - The command refuses to run unless the project's `@oxidevm/sdk` and the CLI
     are the same version, before it stages anything.
   - It stages and verifies this release's assets as `assets install` always
     does. Only then does it write `oxidevm.lock.json`, in one step: a
     temporary file renamed over the old lock. A failed or interrupted run
     keeps the old lock; fix the cause and run it again.
   - It prints the change on stderr:

     ```text
     Updated oxidevm.lock.json for this SDK release:
       SDK     0.0.9 → 0.0.10
       engine  sha256:<old engine> → sha256:<new engine>
       image   sha256:<image> (unchanged)
     ```

     A lock that already matches is not rewritten.
3. Review `oxidevm.lock.json` and commit it with the package update.
4. Start the application and run `npx oxidevm doctor` in the project
   directory. Its `lock` check passes once the lock matches the installed SDK,
   and fails with the explanation above until then.

What changed for code and scripts:

- `InstallAssetsOptions.updateLock` is the option behind `--update-lock`, and
  `InstallAssetsResult.lock` (`ProjectLockChange`: `updated`, `from` and `to`,
  each a `ProjectLockIdentity` of `sdkVersion`, `engineRelease` and
  `manifestSHA256`) reports what installation did to the lock. `from` is present
  only when an existing lock was replaced. Without `updateLock`, a missing lock
  is still written before staging (`updated: true` without `from`) and an
  existing one is never replaced. `assets install` prints on stderr whatever it
  writes to the lock.
- The refusal of an outdated lock stays `INVALID_ARGUMENT` and gains
  `detail: { reason: "project-lock-stale", fields, locked, installed }`. A lock
  whose structure, `image.trust` or `staging` fields, SDK version, engine
  release or image digest cannot be read is refused with `PROTOCOL_ERROR`;
  earlier releases reported some of these as `INVALID_ARGUMENT`.
- With `updateLock`, an image that the configuration does not name needs
  `trust` (`INVALID_ARGUMENT`, reason `project-lock-image-trust`), and a lock
  that changes while assets are staged is left alone (`PERMISSION_DENIED`,
  reason `project-lock-changed`).
- The CLI JSON report is schema 3: every `--json` report has
  `schemaVersion: 3`, the `assets install` result has `lock`, and
  `decodeCliReport` refuses schema 2 reports with
  `unsupported CLI report schema`. Update scripts that compare
  `schemaVersion` with 2.
- `oxidevm doctor` has a new closed check, `lock` (`DoctorCheck`), which reads
  the project configuration named by `--config` or, without it,
  `oxidevm.config.ts` in the current directory. Without either it is
  `not-configured`. `DoctorOptions.project` selects the configuration for
  `doctorProject`. A doctor report without the `lock` check is refused by
  `decodeDoctorReport`.

## Workspaces in several tabs and sites

`createVM` accepts `workspaceInUse: "fail" | "temporary"` (requires `workspaceId`).
`"fail"`, the default, keeps the existing behavior: a workspace another VM holds,
in this tab or another, rejects with `STORAGE_ERROR` and
`detail.reason: "workspace-in-use"`. `"temporary"` opens the VM on a new temporary
workspace instead, which starts empty, saves nothing and is removed with the VM.

`WorkspacePersistence`'s ephemeral form carries a `reason`:
`{ kind: "ephemeral", reason: "no-workspace-id" | "workspace-in-use" }`. Code that
built or compared `{ kind: "ephemeral" }` adds the reason. The in-use error's
message now names the workspace and the ways forward; match on
`detail.reason`, never on the message.

The hosted runtime frame keeps each embedding origin's storage apart: its own
OPFS directory, IndexedDB databases, workspace locks and handoff channels, and
`eraseLocalData` erases only that origin's data. Browsers partition the frame by
top-level site, so before this release pages of one site (for example
`app.example.com` and `docs.example.com`, or two `localhost` ports) shared one
store. A page on this release no longer sees workspaces that a page saved
through an earlier release's frame; that data stays in the browser, and older
frames keep using it. Self-hosted pages keep their storage layout.

A tab that closes without disposing its VM leaves an ephemeral workspace behind;
the next VM of the same origin removes it in the background.

## Relay identity in the hosted frame

Relays see the runtime frame's origin, `https://run.oxidevm.dev`, for every page
that embeds the frame. Before this release the personal relay therefore asked the
user to approve `https://run.oxidevm.dev` with whatever workspace ID the page chose,
whichever site asked, and a server relay's session route could not tell its own
page from any other page that embeds the frame.

A VM in the hosted frame now presents the workspace `<page origin> <workspaceId>`
to relays. The personal relay's approval and session list name the page,
`vm.network.state`'s `awaiting-approval` reports that workspace ID (its `origin`
stays the frame's), and a server relay's session route receives it as
`workspaceId`. The page's origin and `workspaceId` together must fit 256
characters, or `connect` rejects with `INVALID_ARGUMENT`.

The frame also sends a server relay's session request and revocation without
cookies. A session route that authorized frame-hosted pages by cookie, which
needed `SameSite=None` cookies, credentialed CORS for the frame's origin and a
browser that sends third-party cookies, authenticates them with `headers`
instead. Self-hosted pages keep their relay identity and cookies.

## Hosted starter development

New starters select the hosted runtime frame in development and production.
Normal `init` writes signed image references without installing engine files or
image archives. Explicit `--engine-dir` and private operator profiles retain
local runtime staging. A local custom image alone does not select a local engine.

Existing applications can select frame hosting in `src/runtime.ts`. The pinned
hosted runtime must exist. Missing hosted assets fail without a local fallback.
This changes the storage origin. Existing local runtime workspaces remain at
their original origin and do not migrate automatically.

## Doctor for frame-hosted applications

`oxidevm doctor` checks applications on the hosted runtime frame. Earlier
releases reported every browser check of such an application as failed
("deployed browser probe did not load or finish") because it serves no
`/oxidevm/` assets.

- `DoctorReport` has a new required member, `hosting` (type `DoctorHosting`):
  `{ kind: "self-hosted", assets }` with the asset base the doctor probed, or
  `{ kind: "frame", frame }` with this SDK release's runtime frame URL.
  `decodeDoctorReport`, and the CLI's `decodeCliReport` for `doctor`, refuse a
  report without it. Scripts that compare a report's keys add `hosting`.
- A check has a new status, `not-applicable`, only for `worker-load` and
  `storage` and only in a frame-hosted report: they run inside the runtime
  frame. Every other check is still `passed` or `failed`, and a self-hosted
  report keeps all eight browser checks.
- `DoctorOptions` has `hosting` (`"frame"` or `"self-hosted"`) and
  `frameOrigin`, and the CLI has `--hosting` and `--frame-origin`. Without a
  hosting the doctor checks a self-hosted runtime when the application serves
  the SDK's doctor probe at its asset base, and the hosted frame otherwise. A
  self-hosted application is checked as before; pass `--hosting self-hosted`
  to check one that serves no assets yet.
- The CLI's `DoctorCheck` and `DoctorReport` types are now the SDK's, and the
  CLI exports `DoctorHosting` too.

## Image pack order and the starter image 0.0.2

The image builder fills an image's 4 MiB delivery packs in a new order: the
paths a recipe lists in its new `packFirst` option, in that order, then every
other file by guest path, then the evidence. Before, it filled them in
content-hash order. A cold start downloads every pack that holds a file it
reads, so files read together now share packs. A `packFirst` path may cross
symlinks but must end at a file; a path the image does not have fails the
build with `INVALID_ARGUMENT`. Packs are part of the signed manifest, so
rebuilding an unchanged image with this SDK gives it a new manifest digest:
update the references that pin it.

The Python + pandas starter image is now 0.0.2. It has the files of 0.0.1,
with the files a first `python3` run reads packed first, and is signed with a
new author key, `ed25519-d753cdd5739b36c670441766e2c08ea8`. The SDK does not
boot a workspace saved on an image signed by another key: `createVM` rejects
with `PROTOCOL_ERROR` and `detail.reason: "image-trust-changed"`. An app that
moves from the 0.0.1 image to 0.0.2 keeps its users' files by starting such a
workspace again with `restorePoint: "update-image"`, as the generated starter
now does, or starts them on a new `workspaceId`.

## Module commands

This release lets an application turn a command module's commands on for one
Userspace VM, so that every program in the VM runs the module like any other
program (engine ADR 0027). It needs an engine release with Userspace API 145:
with another engine the VM does not start (`CORE_LOAD_FAILED`, "Userspace Wasm
API is unsupported").

- **The `commands` manifest field.** A command module may declare `commands`,
  1 to 16 names that programs in a VM run as `/usr/local/bin/<name>`.
  `module.json` keeps `schemaVersion: 1`. SDK 0.0.8 and earlier do not know the
  field: `oxidevm wasm add` of such a release fails with
  `INVALID_ARGUMENT: module.json: unexpected protocol field commands` (reason
  `wasm-manifest-invalid`, exit status 2), and `oxidevm wasm build` of a
  `module.ts` that declares it reports a `manifest-invalid` finding,
  `module declaration: unexpected protocol field commands`, and exits 3. Update
  the SDK and the CLI together before you install or build such a module. A
  release that adds a command asks for consent again, even from a trusted owner,
  and the comparison shows `+ command:<name>`.
- **`enableModuleCommands`.** New in `@oxidevm/sdk/wasm`, with the types
  `ModuleCommands`, `ModuleCommandsStatus`, `SkippedModuleCommand`,
  `EnableCommandsOptions`, `EnableCommandsArgs` and `ErasedEnableCommandsOptions`.
  Its failures add four reasons: `wasm-module-commands` and
  `wasm-module-command-conflict` (`INVALID_ARGUMENT`),
  `wasm-module-command-unavailable` (`FEATURE_NOT_AVAILABLE`) and
  `wasm-module-command-limit` (`QUOTA_EXCEEDED`). No `VMErrorCode` changes.
- **Commands are checked once each time they are turned on.**
  `enableModuleCommands` fetches and checks every pinned file when it turns the
  commands on, and every run uses those copies; turn the commands off and on to
  check again. `spawnModule` still checks every pinned file at every start, and
  status `121` does not occur for commands.
- **`CommandIO<N>` and `CommandHooks<N>`.** Both take the module's command
  names, `N`, which default to none, so code that names them without a type
  argument is unchanged. For a module that declares commands, `Hooks<M>` is
  `CommandHooks<names>`, and `main`'s `io` also has `invocation` and `terminals`;
  for a module without commands, reading them does not type-check. New types:
  `Invocation`, `Terminals` and `CommandName`.
- **`process.signals`.** A new capability for `requires.host` gives the adapter
  `host.process.signals` (`trap` and `raise`; types `ProcessSignals`,
  `SignalTrap` and `TrappableSignal`). It and `commands` need Userspace API 145
  (`CAPABILITY_MIN_API`, `COMMANDS_MIN_API` and `manifestMinApi`), which the
  consent card shows. A signal that a module does not trap keeps its default
  action, as before.
- **Unfetchable pinned files.** A pinned file that cannot be fetched now ends the
  runner with status `120` and reason `wasm-module-artifact`, and `spawnModule`
  rejects with `CORE_LOAD_FAILED` and `detail.file`. SDK 0.0.8 reported it as an
  adapter fault: status `123`, `GUEST_CRASH` `wasm-module-adapter`.
- **`spawnModule` needs a VM that `createVM` made.** It now starts the runner
  through the VM's private owner record and passes the launch description in the
  runner's start message, so argv and `/proc/<pid>/cmdline` show only the
  caller's arguments. Another object that only has a `spawnJS`, such as a wrapper
  or a test double, is refused with `INVALID_ARGUMENT`, and a System VM or a
  hosted frame's VM with `FEATURE_NOT_AVAILABLE`. A handle that is not one is
  refused with `INVALID_ARGUMENT` `wasm-manifest-invalid` instead of a
  `TypeError`.
- **JS process protocol 4.** Every JS process's start message now carries its
  signal words, and `serveProcess` refuses an older start message: rebuild the
  workers you start with `spawnJS` with this SDK.
- **Placement diagnostics.** `JSProcessPlacementEvent` gains `subject`: `"node"`
  and `"bun"` keep their `runtime`, and `"module-command"` has `runtime: null`
  and runs either in Linux, with the new reasons `module-command-unregistered` and
  `module-command-concurrency` or the existing context and capacity reasons, or
  with `placement: "browser-module"` and the `registration` that turned it on.
  Code that switches on `runtime` or `placement` handles the new values. Traces
  15 and 16 stay readable.
- **`oxidevm wasm doctor` and `oxidevm wasm add --json`.** The doctor has a new
  closed check, `commands`: a note that names the commands each module declares,
  names that more than one module declares, the `PATH` a terminal needs and the
  image programs a name can take the place of. `engine-api` counts commands too.
  The JSON result of `oxidevm wasm add` has `commands` (the names) for a module
  that declares them, other results keep their exact keys, and
  `oxidevm wasm init --json` reports `commands` for a command module.
- **The module template.** `oxidevm wasm init` gives a command module its own id
  as a command (`commands: ["<id>"]`, unless the id starts with `oxidevm`), moves
  its behaviour to `src/command.ts`, which returns `CommandHooks<"<id>">`, and
  adds `test/command.test.ts`, a README section "Run it from a shell" and
  `AGENTS.md` rules for runs that programs in the VM start. A service project is
  unchanged.

## Isolated module workers

This release moves every module worker out of the application's origin (engine
ADR 0028), together with the signal and network changes below. Worker protocol
178, JS process protocol 5, frame protocol 17, module broker protocol 1 and
module frame bootstrap 2 change together; `module.json` stays at schema 1.

- **Module frame.** Module code (`spawnModule`, module commands and services)
  runs in a per-VM sandboxed frame with an opaque origin, opened on first use.
  It can no longer reach the page's cookies, IndexedDB, OPFS, CacheStorage, Web
  Locks, BroadcastChannels or the browser's network. A self-hosted application
  serves the SDK's `assets/module-frame/` at `<runtime.baseUrl>module-frame/`
  with the headers in its `frame.json` (see
  [Deployment](deployment.md#webassembly-modules)); `oxidevm assets install`
  stages it there beside the engine. Under a page CSP, allow the module frame
  in `frame-src`.
- **No fallback.** A browser that cannot isolate module workers refuses modules
  with `FEATURE_NOT_AVAILABLE` `wasm-module-isolation-unavailable` and a
  `detail.capability`. WebKit and Safari refuse modules (`blob-workers`);
  Chromium and Firefox run them.
- **The frame checks its own policy.** A module frame served without the
  `Content-Security-Policy` of its `frame.json` would still be opaque and
  isolated, but module code would have the browser's network. The frame now
  checks that its policy is in force (a fetch of a `data:` URL from the frame,
  and `importScripts` of one from a runner, must be refused) and otherwise
  refuses modules with `capability: "frame-policy"`. A development server or
  middleware made for 0.0.9 that serves `module-frame/` like any other asset
  fails this way; serve it with the frame's headers.
- **Hosted runtime frame.** `spawnModule` and `enableModuleCommands` now work
  with a VM in the hosted runtime frame (frame protocol 17). The page reads the
  module's staged files from its own origin and sends the VM those it lacks;
  `wasm-module-command-unavailable` no longer names the hosted frame.
- **Verify once per VM.** Each pinned file is checked once per VM, by the VM's
  Userspace worker, before any of the module's code runs; later starts and
  command runs reuse the checked copy. A file that does not match makes
  `spawnModule` or `enableModuleCommands` reject with `GUEST_CRASH`
  `wasm-module-integrity` before any process exists, so status `121` no longer
  occurs. A VM holds at most 512 MiB of checked copies (`QUOTA_EXCEEDED`
  `wasm-module-copy-limit`); `wasm-module-command-limit` now counts only command
  sets and names. `host.artifacts.url(name)` is always a `blob:` URL of the
  checked copy. The `integrity` property of `oxidevm wasm test` accepts that
  rejection.
- **Exclusive services.** The VM's Userspace worker takes the workspace lease of
  an `exclusive: "workspace"` service before the process starts. A manifest whose
  `requires.browser` names `indexeddb` or `web-locks` is refused with
  `FEATURE_NOT_AVAILABLE` `wasm-module-prerequisite`, because the module frame has
  neither; drop the declaration when the adapter does not use them.
- **WebCrypto.** In Chromium, `crypto.subtle` is unavailable to module code (its
  workers are not secure contexts); `crypto.getRandomValues` remains.
- **Lost frames.** A module frame that leaves the document or stops answering
  ends the VM's module processes with status `125`; the next start opens a new
  frame.

## Module signals and network reach

This release needs an engine release with Userspace API 146 and release.json
schema 4, which adds a fifth module, `oxidevm_tls.wasm` (identity `tlsApi`
1). With an engine that reports Userspace API 145 the VM does not start
(`CORE_LOAD_FAILED`, "Userspace Wasm API is unsupported"), and `pnpm
engine:pin` refuses a schema 3 release.

- **Every module process carries a network reach (engine ADR 0029).** Rust
  refuses a connection or an addressed datagram beyond it with `EACCES`. A
  module whose `module.json` names `sockets.connect` without a reach token, as
  every module built by an earlier CLI does, has VM-only reach: it still reaches
  programs in its own VM, but no longer the internet. A module without
  `sockets.connect` has no client network at all; the listeners its runner
  exposes still serve VM clients.
- **JS trace 18.** `JSProcessTrace` gains `refusals`, one
  `JSProcessRefusalEvent` (reason `module-network-reach`, the declared reach,
  the attempted scope and the destination) per refused request, empty for
  traces 15 to 17. The request's own service row still carries the errno.
- **JS process protocol 5 signal buffer.** A non-native start message's
  `signals` is now a 1,568-byte buffer: 64 pending bits, Pyodide's interrupt
  word at byte 8 and a ring of 64 real-time arrivals with their details. The
  eight-byte signal words of protocol 4 are refused; rebuild the workers you
  start with `spawnJS` with this SDK. A module's `interruptBuffer` is the view
  of the interrupt word, as before.
- **`host.process.signals` masks.** `block`, `unblock` and `pending` are new
  (types `BlockableSignal` and `SignalName`), and the process keeps the mask it
  inherited. `raise` is now `kill(getpid(), signal)`: a blocked signal stays
  pending instead of reaching its trap at once.
- **Real-time signals.** `trap` also takes `SIGRTMIN` to `SIGRTMAX`, by name
  or number (35 to 64), and is generic in the signals it names: a real-time
  signal yields a `RealtimeArrival` (`signal`, `value`, `code`, `pid`, `uid`), a
  standard one its name as before. New types: `TrapSignal`, `TrapArrival`,
  `TrappedSignal`, `RealtimeArrival` and `RealtimeSignalNumber`. `SignalTrap`
  takes the trapped signals as a type argument, which defaults to
  `TrappableSignal`, so existing code is unchanged.
- **Network reach tokens.** `requires.host` takes `net.vm` or `net.internet`
  (at most one; both need Userspace API 146), and an internet module may add
  `network: { hosts?, purpose? }`, which follows `requires` in `module.json`
  (still `schemaVersion: 1`). SDK 0.0.9 and earlier refuse the new tokens and
  the field: update the SDK and the CLI together before you install or build
  such a module. `oxidevm wasm build` now refuses `sockets.connect` without a
  reach token; add `net.vm` to keep what an earlier build reached. New types:
  `NetHost`, `NetConnectOptions`, `NetConnection`, `NetworkDecl` and
  `ModuleReach`.
- **Module network client.** A module with a reach gets a working `host.net`
  (`resolve`, `connect`, `resolveSync`, `connectSync`, `tls`) and `fetch` and
  `WebSocket` globals on its own VM sockets; a module without one gets
  "network not declared" stand-ins, and `XMLHttpRequest`, `EventSource`,
  `WebTransport` and `RTCPeerConnection` no longer exist in module workers.
  Failures are `NetError` (or `TypeError("fetch failed")` with a `NetError`
  cause); new exports `NetError`, `TlsError`, `NetSyncConnection`,
  `NetTlsSession`, `kit.net`, `kit.tls`, `kit.emscripten.network` and
  `MODULE_EXIT.unavailable` (69). `oxidevm wasm test` reports three more
  properties: `network-direct`, `network-declared` and `network-offline`. The
  engine's TLS module is no longer fetched when a Userspace VM boots.
- **`@oxidevm/sdk/wasm/testing`.** A new export, `testHost(definition, inputs)`,
  runs a module definition through the real runner against an in-memory Linux
  process and VM network for unit tests.
- **`oxidevm wasm init --network none|vm|internet`.** Generated modules declare
  their reach, carry a README "Network" section and AGENTS.md networking rules,
  test their command through `testHost`, and (with a reach) get `src/net.ts`
  and `test/net.test.ts`. The `--json` result of `wasm init` has a new
  `network` field.
- **Install review and doctor.** The consent card has a `network` row (and
  `ConsentCard.network`), a release that widens its reach asks for consent
  again (`+ host:net.internet`), `oxidevm wasm doctor` has a new closed check,
  `network`, and `oxidevm wasm add --json` reports `network` for a module with
  a reach. `oxidevm wasm build` has a new warning, `adapter-network`.
- **Native Node signal listeners (bridge 16).** Images built by this SDK write
  `bridge\t16` into their acceleration profile, and Rust passes it to the SDK in
  the launch record (OXCR 19). Accelerated `node` then lets `process.on` listen
  for SIGQUIT, SIGUSR1, SIGUSR2 and every other catchable standard signal. An
  image built by an earlier SDK keeps bridge 15: SIGHUP, SIGINT and SIGTERM
  listeners work as before, and a listener for another signal throws
  `FEATURE_NOT_AVAILABLE` with reason `native-bridge-signal-listener` until the
  image is rebuilt.

## Module host operations for WASI adapters

Manifests may declare four new `requires.host` capabilities, all needing
Userspace API 147: `files.at` (`host.at`), `clock` (`host.clock`), `random`
(`host.random`) and `process.sync` (`infoSync`, `spawnSync`, `waitSync`,
`signalSync` and `runSync` on `host.process`). `host.net` gains
`connectUnixSync(path)`, and `NetErrorCode` gains `ENOENT`, which a Unix socket
path that names nothing reports. The public types are `LinuxAtFiles`,
`LinuxDirent`, `LinuxNanoTime`, `LinuxPollRequest`, `LinuxPollReady`,
`ClockHost`, `LinuxClock`, `RandomHost`, `ProcessSync`, `NativeSyncChildSpec`,
`NativeSyncRunSpec` and `NativeSyncRunResult` from `@oxidevm/sdk/js-process`.
A manifest that declares `process.sync` lists "programs it starts follow the
VM's own network policy" on its consent card, as `process.spawn` does. Nothing
changes for a manifest that declares none of them.

`host.kit.wasi` runs `wasm32-wasip1` programs over these capabilities (`run`,
`compile`, `readProgram`, `admitShape`, `admit`, `AdmissionError`, `limits`,
`rootPreopen`), and the `oxidevm-bridge` Rust crate (`crates/oxidevm-bridge`)
calls its `oxidevm_bridge_v1` imports. Both are additive.

## Module conformance outcomes

- **`network-offline` for every module.** `oxidevm wasm test` now checks
  `network-offline` for a module that declares no reach as well (it was
  `not-applicable`): with the VM local-only, a command run with your `--arg`s
  ends with a status from 0 to 119 and, when it fails, writes a line on
  standard error; a service stays ready. A command without a reach that exits
  non-zero without a line on standard error now fails this property.
- **A `refused` result.** When the browser cannot isolate module workers
  (`wasm-module-isolation-unavailable`, with its `capability`) or lacks a
  declared prerequisite (`wasm-module-prerequisite`, with what is `missing`),
  `oxidevm wasm test` reports `result: "refused"` with a `refusal` object,
  every property `not-applicable`, and exits `4`. Before, such a run failed
  `integrity` and `exit-range` and exited `3`. Passed and failed reports keep
  `schemaVersion` 1 and their shape; the SDK exports the new
  `WasmTestRefusal` type from `@oxidevm/sdk/image-builder`.

## Module author fixes

Fixes found while building a large interpreter module (Pyodide) against the
private alpha, released with the module networking changes above.

- **`oxidevm wasm test` starts modules.** The conformance page now serves the
  module frame (`module-frame/` beside the runtime, engine ADR 0028) with the
  headers its `frame.json` names, so the `integrity`, `exit-range` and
  `network-offline` properties start the module instead of failing on HTTP 404
  for `module-frame/broker.js`.
- **Up to 64 upstream components.** A manifest's `upstream` list now takes up
  to 64 entries, as many as a release carries artifacts (it took 16). An SDK
  0.0.9 or earlier refuses a manifest with more than 16.
- **Emscripten name lookups and read timeouts.** `kit.emscripten.networkImports(imports)`
  is new: applied to an Emscripten program's imports before instantiation, it
  makes `getaddrinfo` fail with `EAI_NONAME` or `EAI_AGAIN` for a name the VM
  cannot resolve, where the program got `0.0.0.0` before (it still does without
  it). `kit.emscripten.network` now returns an `EmscriptenNetwork` with
  `receiveTimeout(fd, ms | null)`. `NetSyncConnection.read` takes
  `{ timeoutMs }` (`NetReadOptions`): a read that waits longer fails with
  `ETIMEDOUT`, `errno` 11.
- **`data:` URLs are not network use.** The runner no longer writes a
  `network-direct` warning on the module's standard error, and `oxidevm wasm
  test` no longer fails `network-direct`, for `importScripts("data:...")` or a
  policy refusal of a `data:` URL (Pyodide's classic-worker probe); remote URLs
  are still reported. `oxidevm wasm build --check` no longer warns
  `adapter-network` for a literal `data:` URL.
- **Blocking reads in `testHost`.** A synchronous read on the in-memory network
  now waits, as in the browser, instead of failing with `EAGAIN` when nothing
  has arrived yet; a read nothing will ever answer fails with
  `FEATURE_NOT_AVAILABLE` (`testhost-blocked-read`). `TestNet.tcp` serves raw TCP
  services by `host:port` for blocking clients (new types `TestTcpService` and
  `TestConnection`, with `after(ms, action)` on the network's clock).
- **Synchronous artifact reads.** `HostArtifacts` gains `blob(name)`, the VM's
  verified copy as a `Blob`, and `bytesSync(name)`, its bytes read without
  awaiting, both typed by the declared artifact names and served from the
  copies the VM already checked. A hand-written fake `HostArtifacts` in an
  adapter's unit tests needs the two members; `testHost` serves them from the
  artifact bytes it is given.
