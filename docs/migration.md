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
Updating a dependency alone does not migrate a project lock. Select and verify
the replacement release and image before regenerating it.

Restore point formats and runtime support remain experimental. A package
version change does not establish snapshot compatibility or runtime GA.

## Hosted starter development

New starters select the hosted runtime frame in development and production.
Normal `init` writes signed image references without installing engine files or
image archives. Explicit `--engine-dir` and private operator profiles retain
local runtime staging. A local custom image alone does not select a local engine.

Existing applications can select frame hosting in `src/runtime.ts`. The pinned
hosted runtime must exist. Missing hosted assets fail without a local fallback.
This changes the storage origin. Existing local runtime workspaces remain at
their original origin and do not migrate automatically.

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
