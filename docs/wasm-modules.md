# WebAssembly modules

A module wraps a WebAssembly program (PGlite, Pyodide, a Rust crate compiled to
Wasm) so that an application can install it with one command and run it next to
real Linux programs. The module runs in a Userspace JS process, so it shares the
VM's files, process ids and sockets: a native Python client can connect to a
database the module serves, and the module can read files a Linux program wrote.
A command module can also declare `commands`: once the application turns them on
for a VM, every program there runs the module like any other program, as
`/usr/local/bin/<name>` (see
[Run a module's commands from a shell](#run-a-modules-commands-from-a-shell)).

A module has three parts, kept in one repository:

- a **manifest**: a literal object that declares everything the module needs
  (host operations, browser features, guest executables, endpoints it listens on,
  commands, options, license);
- an **adapter**: a function that receives only the host operations the manifest
  declared and returns the hooks the runner drives;
- **artifacts**: the WebAssembly files and notices, pinned by sha256.

A module runs as a JS process of the VM, started by `spawnModule` or by a
program that runs one of its commands. `spawnModule` and `enableModuleCommands`
take a Userspace VM that `createVM` returned on this page, self-hosted or in the
hosted runtime frame, on a cross-origin isolated page. Module code never runs in
your page's origin: it runs in the VM's **module frame**, a sandboxed frame with
an opaque origin and no network of its own (engine ADR 0028; see
[Where modules run](#where-modules-run)). Modules run in Chromium and Firefox;
WebKit and Safari refuse them with a typed error. A running module uses one JS
process, and at most 32 host commands run at once: JS processes, worker threads,
esbuild runs and native commands share that lane. `oxidevm wasm doctor` lists
what each installed module needs from the browser and the image, which it cannot
check itself.

## Use a module

```sh
oxidevm wasm add github:owner/repo@v1.0.0
```

The command resolves the release, shows what the module declares, and asks
before it installs anything. The card says what the module _declares_ because a
module is code that acts on your VM with that authority: its files, processes and
network reach. It runs isolated from your page's origin, but it is not a sandbox
for the VM. Review it the way you review a dependency. The card's `network` row
shows the module's reach, the hosts it discloses and its purpose (see
[Networking](#networking)). For a module with commands the card lists each
command with its path, `/usr/local/bin/<name>`, and says that a command takes the
place of an image program with the same name. For a
GitHub source the card also shows the commit the tag points to, whether the
release is immutable, and whether GitHub holds an attestation for it; the tool
only learns that an attestation exists and does not verify it, so none of these
signals replaces reading what the module declares.

| Written | Commit it? | Purpose |
| --- | --- | --- |
| `oxidevm.modules.json` | yes | your intent: the modules you use and the owners you trust |
| `oxidevm.modules.lock.json` | yes | the exact release of each module, with the sha256 of every file |
| `modules/<id>/module.json` | yes | the manifest of the installed release, so a change shows up in review |
| `.oxidevm/modules/<id>/<release>/` | no | staged files the page serves; each script, stylesheet or page (always the adapter) also has a `.bin` copy, which the handles use |
| `src/oxidevm.modules.generated.ts` | no | typed handles; never edit it |

After a fresh clone run `oxidevm wasm stage` to rebuild the last two from the
lock, and `oxidevm wasm doctor` to check that declaration, lock, committed
manifests, staged files and handles agree.

Sources are `github:owner/repo@tag` and `file:directory`. A `file:` directory
must be inside the project, with no `..` and no symbolic link on the way to it,
so that the lock works wherever the project is cloned: copy a release you are
developing into the project (for example `vendor/tool`) and add `file:vendor/tool`. For a private GitHub
repository the command reads `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`; the
token goes only to `api.github.com`.

### Trust

The first install asks. List an owner under `trusted` in `oxidevm.modules.json`
to skip the question for their later first installs. The file is plain JSON that
you may edit by hand in any layout (`oxidevm wasm add` rewrites it in a fixed one):

```json
{ "schemaVersion": 1, "trusted": ["acme"], "modules": [] }
```

A key that appears twice in one object is an error, because a reader and the tool
would see different files.

A release that asks for more authority than the installed one (a new host
operation, endpoint, guest executable or command) always asks again, even from a
trusted owner, and shows the difference. The installed one is the committed
`modules/<id>/module.json`, but only while it is the very file the lock pins; if
it is missing or edited, everything the release asks for counts as new. A
different publisher under the same id asks like a first install. `--yes` accepts
after you have reviewed the module; with no terminal and no `--yes` the command
refuses and writes nothing. A copyleft release that names no `license.source` is
refused before anything is asked.

Every file of a release is pinned by sha256 in the lock, and the release itself is
named by the digest of its `SHA256SUMS`. Each VM checks each file **once**: the
first `spawnModule` or `enableModuleCommands` that needs a file reads it from your
page's origin, and the VM's Userspace worker checks it against its pin before any
of the module's code runs. The VM keeps the checked copy, with each WebAssembly
artifact compiled once, and every later start and every command run in that VM
uses it without fetching anything. A file that does not match makes the call
reject with `wasm-module-integrity` before any process exists, so exit status 121
no longer occurs. A VM holds at most 512 MiB of checked copies
(`wasm-module-copy-limit`). `host.artifacts.url(name)` is a `blob:` URL of the
checked copy, so a loader that fetches it itself reads the checked bytes.
`host.artifacts.blob(name)` is the checked copy itself, and
`host.artifacts.bytesSync(name)` reads it without awaiting (the module worker's
`FileReaderSync`), for an interpreter that installs a file while it runs and
cannot await, such as one without JSPI importing a package: neither fetches nor
checks anything again, and both take only the declared artifact names. The
synchronous read blocks the module's worker while it copies the file; use
`bytes(name)` where the adapter can await. The
copies guard against a server or cache that changes files later; a new VM checks
again, and so does a new release.

The pins protect the files, not the code's behavior. `mounts` and `state.durable`
are information for the consent card; nothing enforces them, and an adapter can
touch any file its host operations allow. Once a command is on, every program in
the VM can run it, with every host operation the module declares.

**An interpreter command lets programs in the VM use its capabilities.** A
module that runs code it is given, such as a Python interpreter, lets every
program in the VM that runs it (`python3 -c "..."`, or a script that came with a
project) use what the module declares: its host operations and its network
reach. That code runs in the module frame, not in your page's origin, so it
cannot reach your page's cookies, storage, locks or channels (engine ADR 0028).

### Run it

Handles are typed from the manifest: the options a module declares, and its
endpoints, come from the module's own definition.

<!-- typecheck: wasm/use.ts -->
```ts
import type { UserspaceVM } from "@oxidevm/sdk";
import { spawnModule, stopModule } from "@oxidevm/sdk/wasm";
import { database, wordfreq } from "./oxidevm.modules.generated";

export async function demo(vm: UserspaceVM): Promise<number> {
  // A service: it listens until it is stopped, and says where.
  const running = await spawnModule(vm, database, { workspaceId: "project-1", options: { dataDir: "/workspace/pgdata" } });
  console.log(running.endpoints.pg.port, running.info["version"]);

  // A command: it runs once with arguments, like a program.
  const counted = await spawnModule(vm, wordfreq, { args: ["README.md", "counts.json"], cwd: "/workspace" });
  const exit = await counted.exit;

  await stopModule(running);
  return exit.kind === "exited" ? exit.code : -1;
}
```

`spawnModule` returns once a service has bound its endpoints and printed its
ready line, or fails with an error that names the cause. A command returns at
once with a handle whose `exit` settles when it ends. `stopModule` closes the
module's standard input; a service stops accepting, lets working connections
finish for five seconds, then cancels them and runs its adapter's `close` (ten
seconds at most). A process that has not exited twenty seconds after stop is
killed.

A service started with `exclusive: "workspace"` runs at most once per workspace
and module across the page's VMs and tabs: the VM's Userspace worker takes a Web
Lock of its own origin before the process starts and holds it until the process
ends, so module code can neither hold nor steal it. A second start fails fast
with a busy error (`wasm-module-busy`) instead of corrupting a database. A service killed without stopping leaves its socket file,
and the next start decides what to do with it:

- an exclusive service replaces it: its lease rules out another running
  instance, so the file is a leftover, whatever the module's network reach;
- a service with a network reach (`net.vm` or `net.internet`) connects to it
  first, replaces it when nothing listens there, and otherwise fails as busy and
  leaves it alone;
- a service that is neither cannot check, because the engine refuses every
  client connection of a module without a reach, Unix sockets included (engine
  ADR 0029); it fails as busy and leaves the file alone. Declare
  `exclusive: "workspace"` for a service that should recover from a kill on its
  own.

### Run a module's commands from a shell

A command module may declare `commands`, the names under which programs in the
VM run it. Turn them on for one Userspace VM with `enableModuleCommands`:

<!-- typecheck: wasm/commands.ts -->
```ts
import type { UserspaceVM } from "@oxidevm/sdk";
import { enableModuleCommands } from "@oxidevm/sdk/wasm";
import { wordfreq } from "./oxidevm.modules.generated";

export async function shell(vm: UserspaceVM): Promise<void> {
  // Checks the module's files the VM does not hold yet, then places /usr/local/bin/wordfreq in this VM.
  const commands = await enableModuleCommands(vm, wordfreq, { concurrency: 2 });
  const path: "/usr/local/bin/wordfreq" = commands.paths.wordfreq;
  for (const { name, reason } of (await commands.status()).skipped) console.warn(`${name} is not on: ${reason}`);

  // Every program in the VM now runs it like any other program, and so does your own code.
  const counted = await vm.exec({ command: "wordfreq", args: ["README.md", "counts.json"], cwd: "/workspace" });
  console.log(path, counted.exit);

  // Off again: the stub is removed and the commands release their checked copies.
  await commands.disable();
}
```

In a terminal of that VM:

```sh
printf 'one two three' > words.txt
wordfreq words.txt counts.json && cat counts.json   # {"words":3,"compiled":true}
wordfreq; echo $?                                   # the usage line, then 2
```

The module runs as the very process that ran the command: it keeps its process
id, gets the caller's arguments (`io.args`, without `argv[0]`), environment,
working directory, open files and terminal, and its parent waits for its exit
status. Ctrl+C reaches the module: unless the module traps the signal with
`process.signals`, the process ends at once and a shell reports 130. A runner
failure (status 120 to 124) of such a run prints one readable line on standard
error, `<name>: ...`, instead of the JSON record an application start gets.
Commands need what `spawnModule` needs: a Userspace VM that `createVM` made,
self-hosted or in the hosted runtime frame, a cross-origin isolated page and the
default `initialUser: "user"`.

| Option | Meaning |
| --- | --- |
| `commands` | the names to turn on, some or all of the module's `commands`; all of them by default |
| `options` | the module's declared options, as for `spawnModule`, and those without a default are required; they apply to every run, because a program in the VM cannot pass any |
| `concurrency` | how many runs of these commands may be active at once, an integer from 1 to 32; 4 by default |
| `signal` | cancels the call, which turns off again anything it turned on |

With a generated handle, `commands` accepts only the names the module declares,
`options` only its declared options, and `paths` is typed by the names turned on;
a service handle, a module without commands, `args`, `cwd`, `env` and a System VM
do not type-check. The result has `commands` (the names this call turned on, in
the manifest's order), `paths` (each stub's path), `status()` and `disable()`.
`status()` resolves with `{ enabled, skipped }`: whether the commands are still
on, and each name left without a stub, with `reason: "occupied"` when another
file holds its path (that file is left as it is) or `"unavailable"` when placing
the stubs failed the last time the VM's runtime was replaced, for example at a
restore; the next placement tries again. `disable()` removes the stubs and releases
the commands' hold on the checked copies, while runs that already started finish
with theirs. Calling
it again, or after the VM was disposed, does nothing.

**`PATH` and programs with the same name.** Programs find a command at
`/usr/local/bin/<name>` through `PATH`, which must list `/usr/local/bin` before
`/usr/bin`. The SDK's default `PATH` does; keep that order in a `PATH` you set
yourself. A command therefore takes the place of an image program with the same
name, such as `/usr/bin/python3`, for every program that looks the name up,
including scripts that start with `#!/usr/bin/env <name>`, while a program that
runs the image's file by its absolute path still gets that file. A command never
replaces a file that is already at its path: that name is skipped, reported by
`status()`, and the others are turned on.

**On, off and on again.** Commands stay on in their VM until `disable()` or until
the VM is disposed. The SDK keeps them in memory only: they are never saved,
restore points do not capture them, and no other VM shares them. A restore in the
same VM keeps them on and places their stubs again. Turn them on again after every
`createVM`, including after a page reload and when a VM resumes from a restore
point: until then, a stub that the VM's persistent system files kept, or that a
restore point brought back, runs as an ordinary program, prints one line to
standard error and exits with status 126. After `disable()` the command is gone:
a shell reports it as not found (status 127), or runs the image's program with
that name again.

**How many run at once.** `concurrency` bounds the active runs of one call's
commands, and every JS process of the VM counts toward its 32 host commands. A run
beyond either limit does not wait: the stub runs as an ordinary program and exits
with status 126, and the placement trace (`readJSProcessTrace` from
`@oxidevm/sdk/diagnostics`) names the reason, `module-command-concurrency` or
`command-capacity`.

### Where modules run

Each VM gets one hidden **module frame** the first time `spawnModule` or
`enableModuleCommands` needs it, and loses it when the VM is disposed (engine
ADR 0028):

- The frame is an `<iframe sandbox="allow-scripts" allow="cross-origin-isolated">`
  whose document comes from the runtime's own origin, so the sandbox gives it an
  opaque origin. A broker worker runs there, with one runner worker per module
  process. The broker relays every request of a module process to the VM's
  Userspace worker; a synchronous request pays a relay of about 0.1 ms
  (diagnostic measurement on a loaded host).
- Module code has no access to your page's cookies, IndexedDB, OPFS,
  CacheStorage, Web Locks or BroadcastChannels, and no network of its own
  (`connect-src blob:`); its network is the VM's (see [Networking](#networking)).
  In Chromium, workers of an opaque origin are not secure contexts, so
  `crypto.subtle` is unavailable to module code; `crypto.getRandomValues`
  remains.
- A manifest whose `requires.browser` names `indexeddb` or `web-locks` is refused
  with `wasm-module-prerequisite`, because the frame has neither.
- The broker treats every message from a runner as hostile input: a malformed one
  ends only the process that sent it, with status 125.
- A frame that is removed from the document, or whose broker stops answering,
  is lost: the VM ends its module processes with status 125, and the next call
  opens a new frame.

Where the frame document is served:

| Runtime | Module frame |
| --- | --- |
| Hosted runtime frame | `/v/<sdk version>/module-frame/` of the runtime origin, served by the runtime frame deployment of an SDK version that has module isolation. Your page still reads the module's staged files from its own origin and hands the VM the files it does not hold yet. |
| Self-hosted | `module-frame/` beside the engine assets, at `<runtime.baseUrl>module-frame/`; you serve it, see [Deployment](deployment.md#webassembly-modules). |

A browser that cannot isolate module workers refuses modules with
`FEATURE_NOT_AVAILABLE`, `reason: "wasm-module-isolation-unavailable"` and a
`capability` that names what failed: `frame-load`,
`frame-cross-origin-isolation`, `separate-origin`, `worker-shared-memory`,
`worker-atomics-wait`, `blob-workers`, `wasm-compilation`,
`separate-agent-cluster`, `module-frame-lost` or `frame-policy`. The frame probes these in every
browser; there is no browser allowlist and nothing falls back to your page's
origin. `frame-policy` means the frame was served without the
`Content-Security-Policy` of its `frame.json`: the frame checks that a fetch of
a `data:` URL from its document and `importScripts` of one from a runner are
refused, because without that policy module code would have the browser's
network. WebKit fails `blob-workers` today (under COEP no `blob:` worker starts in
the frame), so Safari refuses modules. Safari itself has not been tested; the
evidence comes from Playwright's WebKit on Linux.

### Bundlers and security policy

The generated handles name staged files with `new URL(path, import.meta.url)`, so
bundlers copy them as assets. Vite inlines files smaller than 4 KiB as `data:`
URLs; both forms work, and the sha256 check applies either way. Set
`assetsInlineLimit: 0` if you want every file served as a file. Development servers rewrite files
they serve as scripts, stylesheets or pages (Vite adds import analysis to a `.mjs`), which would
change the bytes the lock pins, so the handles name the neutral `.bin` copies that staging keeps
beside those files; `oxidevm wasm doctor` checks the copies too. Under a content
security policy, your page needs `connect-src 'self'` to read the staged files
(and `data:` when a bundler inlines them) and, self-hosted, the frame's
`broker.js` and `runner.js`, and `frame-src` for the origin that serves the module
frame: `'self'` when self-hosted, the runtime origin when hosted. The runner
imports the verified adapter from a `blob:` URL inside the module frame, under
the frame's own policy.

### Snapshots

A restore point cannot capture a live JS process, so `snapshots.capture` fails
with `FEATURE_NOT_AVAILABLE` while a module runs, including one that a program in
the VM started as a command. Stop the modules, capture, and start them again; a
service reopens its durable state.

### Errors

A failure of `spawnModule` to start a module, or of `enableModuleCommands`, is a
`VMError` with a stable `detail.reason`:

| Reason | Code | Meaning |
| --- | --- | --- |
| `wasm-module-launch` | `GUEST_CRASH` | the launch descriptor was missing, oversized or invalid |
| `wasm-module-integrity` | `GUEST_CRASH` | a file or the adapter did not match its pinned sha256; the call rejects before any process exists, and `detail.file` names the file |
| `wasm-module-artifact` | `CORE_LOAD_FAILED` | a pinned file could not be fetched: the request failed or the server answered with an HTTP error; `detail.file` names it |
| `wasm-module-prerequisite` | `FEATURE_NOT_AVAILABLE` | a declared browser feature or guest executable is missing, or `requires.browser` names `indexeddb` or `web-locks`, which the module frame does not have; `detail.missing` lists them |
| `wasm-module-isolation-unavailable` | `FEATURE_NOT_AVAILABLE` | this browser cannot isolate module workers, or the VM's module frame was lost; `detail.capability` names the failed check (see [Where modules run](#where-modules-run)) |
| `module-frame-asset` | `CORE_LOAD_FAILED` | the module frame's `broker.js` or `runner.js` could not be fetched from `<runtime.baseUrl>module-frame/` |
| `wasm-module-copy-limit` | `QUOTA_EXCEEDED` | the VM would hold more than 512 MiB of checked module files |
| `wasm-module-adapter` | `GUEST_CRASH` | the adapter threw, had the wrong shape, or returned an invalid status |
| `wasm-module-busy` | `QUOTA_EXCEEDED` | another process holds the workspace lease or an endpoint |
| `wasm-module-ready` | `PROTOCOL_ERROR` | the service printed no valid ready line |
| `wasm-module-options` | `INVALID_ARGUMENT` | an option passed to `spawnModule` or `enableModuleCommands` is unknown, has the wrong type or is out of range, or a required one is missing |
| `wasm-module-commands` | `INVALID_ARGUMENT` | `enableModuleCommands` got a service or a module without commands, a `commands` list that is empty, repeats a name or names one the module does not declare, a `concurrency` that is not an integer from 1 to 32, or another field, such as `args`; nothing has been fetched |
| `wasm-module-command-conflict` | `INVALID_ARGUMENT` | another `enableModuleCommands` call already turned on one of the names in this VM |
| `wasm-module-command-unavailable` | `FEATURE_NOT_AVAILABLE` | the VM cannot run module commands: it was not created by this copy of the SDK, is a System VM, has a root initial user or no image, or the page is not cross-origin isolated; nothing has been fetched |
| `wasm-module-command-limit` | `QUOTA_EXCEEDED` | the VM already has 16 sets of commands on, or would have more than 64 command names |
| `wasm-manifest-invalid` | `INVALID_ARGUMENT` | a manifest, lock, handle or descriptor failed validation |

`enableModuleCommands` also fails with `STORAGE_ERROR` when the VM's system files
cannot be changed (`detail.outcome` is `busy`, `directory-unavailable` or
`filesystem`, the last with `errno`), and with `ABORTED` when its `signal` aborts.
When it fails, nothing is turned on. The one exception is a cancellation that
reaches the VM after it turned the commands on: the call turns them off again,
and if that fails too, `ABORTED` says so in `detail.cleanupFailed` and the
commands stay on until the VM is disposed.

A module that ends reports an exit status, which a shell sees as `$?`:

| Status | Meaning |
| --- | --- |
| `0`-`119` | the adapter's own status |
| `120` | the module could not be launched |
| `121` | reserved for a file that did not match its pin; since files are checked before the process exists, the call rejects with `wasm-module-integrity` instead and no process ends with it |
| `122` | a declared browser feature or guest executable is missing |
| `123` | the adapter threw, had the wrong shape, or returned an invalid status |
| `124` | another process holds the service's workspace lease or an endpoint |
| `125` | the engine reports a failed worker, the module frame was lost, or the broker ended a process that sent it a malformed message |
| `126` | a command's stub ran as an ordinary program and printed why on standard error: the command is not on in this VM, the file is a copy of the stub at another path, the caller does not run as uid and gid 1000 outside a container, or `concurrency` runs or the VM's 32 host commands are already in use |
| `128` + n | signal n ended the process, for example `130` for Ctrl+C; the process handle's `exit` is `{ kind: "signaled" }` |

A command that `disable()` turned off is gone: a shell reports `127` (not found),
or runs the image's program with that name.

## Write a module

```sh
oxidevm wasm init my-tool                  # a command module wrapping a tiny Wasm function
oxidevm wasm init my-db --kind service     # a service listening on a Unix socket
oxidevm wasm init wrapped --from lib.wasm  # start from your own WebAssembly file
oxidevm wasm init fetcher --network internet  # declare a network reach: none (default), vm or internet
```

The project has strict TypeScript and ESLint settings, unit tests on `testHost`, CI
and release workflows, a README "Network" section, and an `AGENTS.md` for coding
agents with the networking rules. `--network vm` or `internet` declares the reach
and adds `src/net.ts` (a bounded, cancellable request) and its tests. Everything lives in `module.ts`
and `src/`:

<!-- typecheck: wasm/define.ts -->
```ts
import { defineModule } from "@oxidevm/sdk/wasm";

export default defineModule({
  manifest: {
    id: "wordfreq",
    version: "0.1.0",
    abi: "bindgen",
    artifacts: [
      { name: "wordfreq_bg.wasm", from: "upstream/wordfreq_bg.wasm" },
      { name: "NOTICES.txt", from: "NOTICES.txt" },
    ],
    process: { kind: "command" },
    requires: { host: ["files.sync"] },
    license: { spdx: "MIT", notices: ["NOTICES.txt"] },
  },
  adapter: async host => {
    const compiled = await host.artifacts.compile("wordfreq_bg.wasm");
    return {
      main(io) {
        const [input, output] = io.args;
        if (input === undefined || output === undefined) return host.fail(2, "usage: wordfreq <in> <out>");
        const text = new TextDecoder().decode(host.fs.readFile(input));
        host.fs.writeFile(output, new TextEncoder().encode(JSON.stringify({ words: text.split(/\s+/u).length, compiled: compiled instanceof WebAssembly.Module })));
        return 0;
      },
    };
  },
});
```

The build reads the manifest **without running your code**, so it must be a
literal: no variables, calls or spreads. Its type is inferred from the literal and
fixes the adapter's shape:

- `host` holds exactly the members of the capabilities in `requires.host`, plus the
  base members; asking for `host.sockets` without declaring `sockets.connect` is a
  type error.
- A service's `protocols` must have exactly the keys of `expose`.
- `host.artifacts.compile(name)`, `bytes(name)` and `url(name)` accept only
  declared artifact names, and all three give the copy the VM checked: `compile`
  returns the module compiled once for the VM, `bytes` its bytes, and `url` a
  `blob:` URL of it for a loader that fetches its own files.
- `host.options` holds the declared options with defaults applied.

The adapter is a **factory**: it runs once at start with `host`, keeps its state in
its closure, and returns hooks. A command returns `main(io)`, which returns an
exit status from `0` to `119`; a service returns one handler per endpoint, which
runs for the life of one connection, plus an optional `info()` for the ready line
and `close()` for stop. A write to a client that has hung up rejects with an error
instead of ending the module: the handler can catch it, or let the runner log it and
close that one connection.

### Capabilities and host members

| `requires.host` token | `host` member | Provides |
| --- | --- | --- |
| `files.sync` | `fs` | synchronous file operations on the VM's files |
| `files.async` | `files` | the same operations as promises, with `AbortSignal` |
| `files.at` | `at` | synchronous descriptor-relative operations (`openat` with openat2's `resolve`, `statAt`, `mkdirAt`, `unlinkAt`, `renameAt`, `linkAt`, `symlinkAt`, `readlinkAt`, `utimensAt`), positional `pread`/`pwrite`, status flags, raw `getdents` batches with inodes and `d_off` cookies, `fdatasync`, and `poll` with a timeout; `at.cwd` is `AT_FDCWD` (Userspace API 147) |
| `clock` | `clock` | `now` and `resolution` of the VM's `realtime` and `monotonic` clocks, in nanoseconds as `bigint`: the clocks native programs read (Userspace API 147) |
| `random` | `random` | `fill(bytes)` from the VM's entropy, as `getrandom` gives it to native programs (Userspace API 147) |
| `sockets.connect` | `sockets` | raw client sockets (listening belongs to the runner); a new module pairs it with `net.vm` or `net.internet` |
| `net.vm` | `net` | network reach: programs in this VM (Userspace API 146; see Networking) |
| `net.internet` | `net` | network reach: also the internet through the VM's connection (Userspace API 146; see Networking) |
| `process.info` | `process.info`, `process.cwd` | this process's id, credentials and directory |
| `process.spawn` | `process.spawn`, `process.wait`, `process.signal` | native child processes |
| `process.sync` | `process.infoSync`, `process.spawnSync`, `process.waitSync`, `process.signalSync`, `process.runSync` | blocking process calls for code that cannot await; `spawnSync({ owned: true })` and every `runSync` child are killed with SIGKILL when the module's process ends, and `runSync` enforces its own deadline and output limits (Userspace API 147) |
| `process.signals` | `process.signals` | trap SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2 and the real-time signals instead of their default action, block and unblock signals, list pending ones, and raise a signal (Userspace API 145; masks and real-time signals need 146) |

`host.at`, `host.clock`, `host.random` and the synchronous `host.process` calls
travel on the module process's own Linux channel and block only its worker; Rust
resolves every path, against the descriptor it is given, and owns the clocks and
the entropy. `process.runSync({ command, args, cwd, env, input, timeoutMs,
stdoutLimit, stderrLimit })` takes an absolute command with at most 63 arguments,
at most 5 MiB of input, a timeout from 1 ms to 180 s of the VM's monotonic clock
and limits of at most 1 MiB per output; an invalid run is `INVALID_ARGUMENT`
before anything starts. It feeds the input and drains both outputs in one loop
whose every wait is bounded by the deadline, so a descendant that keeps a pipe
open cannot hold it past its deadline. A timeout is a `LinuxError` with errno 110
(ETIMEDOUT) and an output past its limit errno 7 (E2BIG), each after the child was
killed and reaped. Once the child has closed both outputs, `runSync` waits for its
exit without a deadline: the wire has no non-blocking wait yet. In `testHost` the
clocks and `random` are deterministic (`random` is test bytes, never entropy), and
`spawnSync`, `waitSync`, `signalSync` and `runSync` are not modelled (ENOSYS).

Every host also has `signal`, `options`, `artifacts`, `stdio`, `log(line)`,
`fail(status, message)` and `kit`: tested helpers for Linux-to-Emscripten errno
mapping, length-prefixed framing, a FIFO session gate, running a native command
with bounded output, atomic directory creation, and the network adaptation of
[Networking](#networking) (`kit.emscripten.network`,
`kit.emscripten.networkImports`, `kit.tls`, `kit.net.describe` and
`kit.net.errno`). Use the kit instead of rewriting these; a module never imports
it.

### WASI programs (`kit.wasi`)

`host.kit.wasi` runs a compiled `wasm32-wasip1` program (Rust, C, Zig) as the
module's own Linux process: WASI Preview1 over the process's real descriptors and
the VM's live files, clocks and entropy, plus the `oxidevm_bridge_v1` imports for
process identity, native children and VM sockets that the `oxidevm-bridge` Rust
crate (`crates/oxidevm-bridge`) calls. Every call is synchronous for the program;
no JSPI or Asyncify is involved.

```ts
adapter: async host => {
  const program = await host.kit.wasi.compile(await host.artifacts.bytes("tool.wasm"));
  return { main: io => host.kit.wasi.run(host, program, io, { argv: ["tool", ...io.args] }) };
},
```

`compile` checks the bytes (one bounded, unshared 32-bit memory, at most one
bounded table, no start section), compiles, and checks the imports; a refused
program throws `AdmissionError` and runs no code. `run` uses whichever members the
manifest declared: `files.at` (preopens and every path function), `clock`,
`random`, `process.info`, `process.sync` and a network reach; a function whose
capability is absent returns `NOSYS`. `options.preopens` narrows the default grant
(the whole tree under the process's own credentials) to confined directories,
optionally read-only. `readProgram(host, path)` reads a program file from the VM
once (at most 32 MiB). The source is `packages/sdk/src/wasm/kit/wasi/`; the user
guide is `apps/docs` "Run Rust programs" in the engine repository, and the
interface reference is "oxidevm_bridge_v1".

The Rust crate lives in `crates/oxidevm-bridge` here, so the interface and both
of its sides change in one pull request: run `pnpm test:bridge` (rustfmt, tests,
clippy on `wasm32-wasip1`, rustdoc) after changing either side.

### Commands and signals

A command module that declares `commands` runs for programs in a VM once an
application turns them on. `main(io)` then also gets `io.invocation`,
`{ kind: "host" }` when the application started the module with `spawnModule` or
`{ kind: "command", name, path, argv0 }` when a program ran one of its commands,
and `io.terminals`, whether `stdin`, `stdout` and `stderr` are terminals. Without
`commands` these members do not exist, and reading them does not type-check.
Write `main` for such a caller:

- name the command with `io.invocation.argv0` in usage lines and errors, because
  the caller may have typed a path or a link; `io.args` never contains `argv[0]`;
- expect any standard input, a terminal, a pipe, a file or nothing: read it only
  when the command's interface says so, until a read returns no bytes, and use
  colour or prompts only on a terminal;
- return `0` to `119` from `main`, and `2` for a usage error; a throw ends the run
  with status `123`;
- keep start-up cheap: every run starts a fresh process that runs the adapter
  factory again, although the files were checked, and the WebAssembly artifacts
  compiled, once when the commands were turned on;
- choose names with care: a command takes the place of an image program with the
  same name, and a release that adds one asks every application to consent again.

A signal that the module has not trapped keeps its default action: Ctrl+C
(SIGINT), SIGTERM, SIGHUP and the others end the process at once, `close()` does
not run, and the parent sees the process killed by that signal. To clean up
first, declare `process.signals` and trap them:

```ts
// module.ts declares requires: { host: ["files.sync", "process.signals"] }.
async main(io) {
  // From here on, Ctrl+C writes its signal number into the interrupt buffer instead of ending the process.
  const trap = await host.process.signals.trap(["SIGINT"]);
  let interrupted = false;
  for (const file of io.args) {
    interrupted = trap.interruptBuffer[0] !== 0;
    if (interrupted) break; // stop between two files, never halfway through one
    convert(file);
  }
  await trap.untrap();
  // End the way Ctrl+C would have: the shell reports 130, and a loop that runs this command stops.
  if (interrupted) await host.process.signals.raise("SIGINT");
  return 0;
},
```

`trap(signals)` takes any of SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1 and
SIGUSR2, and the real-time signals by name (`SIGRTMIN`, `SIGRTMIN+n`,
`SIGRTMAX-n`, `SIGRTMAX`) or by number (35 to 64), naming each signal once, and
resolves once they reach the module instead of their default action. A real-time
signal arrives as `{ signal, value, code, pid, uid }`: every `sigqueue` value
queues in order, and one that arrives past the process's queue limit has the
zeros Linux reports for it;
SIGKILL and SIGSTOP never can, and a signal the process inherited as ignored stays
ignored. The trap is an async iterable of the trapped signals as they arrive, and
a signal that arrives again before the module has seen it is delivered once.
`interruptBuffer` is an `Int32Array` in the format that Pyodide's
`setInterruptBuffer` reads: the runtime writes the signal's number into element
0 while it reads 0, and the reader resets it. A reader that acts on the signal
takes it with one `Atomics.exchange(buffer, 0, 0)`; a plain read followed by a
store of 0 loses a signal that arrives between the two, and nothing writes it
again. Pyodide's own poll (`_Py_CheckEmscriptenSignals_Helper`) is such a read
and store, so a Pyodide adapter replaces it with an atomic take; otherwise
Ctrl+C on a busy loop is lost now and then. While a signal is trapped, its arrival makes a host
operation that is waiting fail with `EINTR`. `untrap()` gives the signals their
default action back. `raise(signal)` is `kill(getpid(), signal)`: a trapped signal
reaches its trap, and one that is not trapped ends the process killed by it, so a
shell reports 128 + n; its promise never settles then. Finish quickly once a
trapped signal arrives, then `untrap()` and `raise()` it.

`block(signals)` and `unblock(signals)` change the process's signal mask, as
`sigprocmask` does, and resolve with the previous mask as a set of names; SIGKILL
and SIGSTOP can never be blocked. A signal that arrives while blocked stays pending
(`pending()` lists them) and is delivered once when it is unblocked. A process
starts with the mask it inherited, so a module started from a shell that blocks
SIGINT does not see Ctrl+C until it unblocks it.

### Networking

Every module states how far it reaches on the network, and the engine holds each
of its processes to that statement (engine ADR 0029). Module code never uses the
browser's own network: everything it sends travels on its process's own sockets
inside the VM, under the rules every guest program follows.

**For applications that install a module.** A module with internet reach reaches
the internet only once your application connects the VM through a relay
(`vm.network.connect`) and the user allows the session on the relay's control
page; until then it gets `EPERM`, and a revoke resets its open connections. Its
connections, like any guest program's, show in the personal relay's destination
list (from personal relay 0.2.0, the Linux x64 beta offered with SDK 0.0.10). Through the relay, the internet means public hosts on TCP 80 and 443, plus
DNS. Nothing on the internet can connect in. Programs a module starts with
`process.spawn` are ordinary Linux programs under the VM's own network policy,
not the module's reach, and the card says so. An interpreter command lets the
programs that run it use its reach.

**N-1 One declared reach.** `requires.host` names at most one reach token:

| Reach | `requires.host` | The module may | It gets |
| --- | --- | --- | --- |
| none | no reach token | open no connections of its own; a service still serves programs in the VM through `expose` | nothing network-related; `fetch` and `WebSocket` fail with "network not declared" |
| VM-only | `net.vm` | connect to programs in this VM: loopback, Unix sockets and the VM's own addresses; resolve names from the VM's `/etc/hosts` | `fetch`, `Request`, `Response`, `Headers`, `WebSocket` and `host.net` |
| internet | `net.internet` (includes VM-only) | also reach public hosts on TCP 80 and 443 through the VM's relay connection, with DNS through the VM's resolver | the same |

Naming both tokens is refused. `sockets.connect` (`host.sockets`, raw client
sockets) needs a reach token: `oxidevm wasm build` refuses it alone. A
`module.json` built by an earlier CLI that names `sockets.connect` alone has
VM-only reach; rebuild it with `net.internet` to reach the internet. The tokens
need Userspace API 146.

**N-2 Disclosure, never an allowlist.** A module with `net.internet` may add
`network: { hosts?, purpose? }`: up to 32 DNS names it contacts by default (a
leading `*.` is allowed) and one sentence of up to 200 characters. The install
review and `oxidevm wasm doctor` show them; nothing enforces them, because an
interpreter reaches whatever host its program asks for. `network` without
`net.internet` is invalid.

**N-3 Only the host's network.** The module frame allows no network
(`connect-src blob:`). For a module with a reach, the runner installs `fetch`,
`Request`, `Response`, `Headers` and `WebSocket`, plus `host.net`, all on the
module process's own VM sockets:

- names resolve from the VM's `/etc/hosts` and, for internet reach, the
  nameservers of its `/etc/resolv.conf`, asked over the process's own datagram
  socket, so the module gets the answers a guest program gets; a VM-only module
  resolves from `/etc/hosts` alone;
- TLS runs inside the module's worker, end to end, with the engine's TLS module
  (fetched once per VM, the first time a module with a reach starts, and never in
  a VM whose modules have none);
- `fetch` follows Node's semantics, not a page's: no CORS, any request header,
  redirects, gzip and deflate, keep-alive, streamed bodies, `AbortSignal`, and
  timeouts (10 s to connect, 300 s for the response head and between body
  reads); `WebSocket` is the standard client over RFC 6455;
- `host.net.resolve` and `connect({ host, port, tls, alpn })`, their blocking
  `resolveSync` and `connectSync` for interpreters that cannot await,
  `connectUnixSync(path)` for a Unix-domain socket in the VM (Userspace API 147;
  Rust holds it to the module's reach as it does TCP), and
  `host.net.tls()` for a sans-IO TLS session. A blocking connection's
  `read(max, { timeoutMs })` waits at most `timeoutMs` (0 to 86,400,000) for
  bytes, then fails with `NetError` code `ETIMEDOUT` and `errno` 11 (EAGAIN, as
  Linux reports a receive timeout); without it the read waits for bytes or the
  end of the stream.

`XMLHttpRequest`, `EventSource`, `navigator.sendBeacon`, `RTCPeerConnection`,
`WebTransport`, and `import()` or `importScripts` of anything but a blob do not
work in a module worker. `oxidevm wasm build --check` warns about bundled uses of
them (`adapter-network`), and `oxidevm wasm test` fails `network-direct` when a
module attempts one. A `data:` URL is not a network use: the frame's script
policy refuses `importScripts("data:...")` too, but neither check reports it.

**N-4 Adapting a program's own network layer.**

- Emscripten programs: `host.kit.emscripten.network(host, Module)` connects the
  program's SOCKFS stream sockets (blocking, through `host.net.connectSync`) and
  `getaddrinfo` to the VM network. Export `SOCKFS`, `DNS` and `FS` with
  `EXPORTED_RUNTIME_METHODS`. Listening sockets are refused with `EOPNOTSUPP`.
  Emscripten's own `getaddrinfo` has no way to fail a lookup, so also pass the
  program's imports to `host.kit.emscripten.networkImports(imports)` before it
  is instantiated (in `Module.instantiateWasm`, or where the adapter calls
  `WebAssembly.instantiate`): a name with no IPv4 address then fails with
  `EAI_NONAME` (-2) and a lookup that could not be made (offline, beyond the
  reach, no nameserver answer) with `EAI_AGAIN` (-3), as a C library reports
  them; without it such a name gets `0.0.0.0` and connecting to it fails.
  `network` returns `receiveTimeout(fd, ms | null)`, the socket's SO_RCVTIMEO,
  which Emscripten's `setsockopt` does not pass on: an interpreter calls it when
  its program sets a socket timeout, and a `recv` that waits longer fails with
  `EAGAIN`.
- Programs without TLS: `host.net.connect({ tls: true, alpn })`, or the sans-IO
  session of `host.kit.tls.session` and `host.kit.tls.handshakeSync`. A session
  takes `trust`, extra anchors for that session only (each a PEM bundle or one
  DER certificate, at most 512 certificates in all and 2 MiB, so a full public
  root bundle such as certifi's fits), the way
  `SSLContext.load_verify_locations` adds a CA file. They add to the VM's
  `/etc/ssl/cert.pem` and never switch verification off; an entry that is not a
  CA certificate fails with `ERR_TLS_INVALID_TRUST`. After the handshake,
  `peerCertificates()` (DER, leaf first), `protocolVersion()` (`"TLSv1.2"` or
  `"TLSv1.3"`), `cipherSuite()` (the IANA id) and `alpn()` give what
  `getpeercert()`, `version()`, `cipher()` and `selected_alpn_protocol()`
  report. These need engine TLS API 2.
- WASI preview 1 programs have no sockets; their JavaScript glue uses `fetch` or
  `host.net`.

**N-5 Offline, revoked and refused.** Failures are typed. `fetch` rejects with
`TypeError("fetch failed")` whose `cause` is a `NetError` (exported from
`@oxidevm/sdk/wasm`), and `host.net` and sockets fail with the same codes:

| Situation | `cause.code` | `cause.reason` |
| --- | --- | --- |
| the VM is not connected yet | `EPERM` | `vm-local-only` |
| the user revoked the connection | `ECONNRESET` | |
| beyond the declared reach | `EACCES` | `module-network-reach` |
| a certificate the VM does not trust | `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `ERR_TLS_CERT_ALTNAME_INVALID`, `CERT_HAS_EXPIRED`, ... | |

A command prints one line from `host.kit.net.describe(error, argv0)` and
returns 69, `MODULE_EXIT.unavailable` (sysexits `EX_UNAVAILABLE`; the adapter
bundle imports no SDK values except `defineModule`, so write the number, and use
the constant in tests); a service fails only the affected request and stays
ready. Nothing retries in a loop.

**N-6 Cancellation and bounds.** Pass `host.signal`, or a signal derived from
it, and a timeout to every request, and stream or bound every body.

**N-7 Trust and credentials.** TLS always verifies against the VM's own trust
store, `/etc/ssl/cert.pem`, which is what `curl` in the image trusts. No host API
switches verification off, and the SDK bundles no CA data. Credentials reach a
module only through its options or guest files; its frame holds no page cookies
or storage.

**N-8 Limits.** Internet means TCP 80 and 443 plus DNS, the relay's policy.
Nothing on the internet connects in: services serve VM clients through `expose`.
Module code gets no raw datagram sockets; the runner uses one internally for
DNS.

**N-9 Testing.** `testHost({ net })` from `@oxidevm/sdk/wasm/testing` gives
unit tests the same reach checks and errors on an in-memory network (see
[Build, test, release](#build-test-release)). `oxidevm wasm test` checks three
network properties: `network-direct`, `network-declared` and `network-offline`.

**N-10 Documentation.** A module's README has a "Network" section: the reach,
the disclosed hosts and purpose, and what happens offline.
`oxidevm wasm init --network none|vm|internet` generates the declaration, that
section, `AGENTS.md` rules and tests; the default is `none`.

A module with internet reach, as a command:

```ts
// module.ts declares requires: { host: ["files.sync", "net.internet"] } and
// network: { hosts: ["api.example.com"], purpose: "Downloads the current rates." }.
async main(io) {
  const [output = "rates.json"] = io.args;
  try {
    // Cancelled when the module stops, and bounded in time.
    const signal = AbortSignal.any([host.signal, AbortSignal.timeout(30_000)]);
    const response = await fetch("https://api.example.com/rates", { signal });
    if (!response.ok) return host.fail(1, `rates: HTTP ${String(response.status)}`);
    host.fs.writeFile(output, new Uint8Array(await response.arrayBuffer()));
    return 0;
  } catch (error) {
    // One line, such as "rates: network unavailable: this VM is not connected to the internet".
    host.log(host.kit.net.describe(error, "rates"));
    return 69; // MODULE_EXIT.unavailable
  }
},
```

What is verified: all 16 scenarios of the module networking browser run pass in
Chromium 149 and Firefox 151, with the runtime self-hosted and in the hosted
runtime frame (`docs/plans/2026-11-02-module-follow-ups/evidence/networking-sl-n4.md`).
With the VM local-only, they cover the reach checks, the offline and refused
paths, VM-only `fetch`, and the module frame having no browser network. Through a
relay, they cover internet HTTPS `fetch` and `wss` with TLS verified against the
VM's trust store, DNS answers that match guest `curl`, the relay's destination
list, and a relay-side revoke or `vm.network.disconnect()` during a download
ending it with `ECONNRESET`. Limits: no live internet was used. A relay test peer
stood in for the relay, its DNS and routing sent a test name to local servers,
and the TLS certificate came from a throwaway test CA added to the VM's trust
store. The destination list checked was the test peer's table, built on the
native relay's rules; the personal relay's control page was not driven; its destination list
ships in personal relay 0.2.0, offered with SDK 0.0.10.
WebKit and Safari refuse modules.

### Manifest fields

| Field | Meaning |
| --- | --- |
| `id`, `version` | lower-case id (up to 63 characters) and a semantic version |
| `abi` | `wasi`, `component`, `emscripten`, `bindgen` or `raw`; `oxidevm wasm inspect file.wasm` reports what a binary appears to use |
| `artifacts` | `{ name, from }`: files of your repository the release carries |
| `process` | `{ kind: "command" }` or `{ kind: "service", exclusive?: "workspace" }` |
| `commands` | command modules only: 1 to 16 unique names, stored sorted, each matching `^[a-z0-9][a-z0-9_.+-]{0,63}$` and none starting with `oxidevm`; once an application turns them on for a VM, programs there run each as `/usr/local/bin/<name>`. `requires.guest.executables` cannot list the module's own commands |
| `expose` | a service's endpoints, keyed by name: a Unix socket under `/workspace/_oxidevm/` or `/tmp/`, or loopback TCP on 1024-65535, each with a `protocol` label |
| `requires.host` | capabilities from the table above |
| `network` | only with `net.internet`: `{ hosts?, purpose? }`, up to 32 DNS names it contacts by default (a leading `*.` allowed, stored sorted) and one sentence of up to 200 characters; shown at install, never enforced |
| `requires.browser` | `cross-origin-isolated`, `indexeddb`, `jspi`, `web-locks`; checked before the adapter runs. The module frame has no IndexedDB and no Web Locks, so a manifest that names `indexeddb` or `web-locks` cannot start (`wasm-module-prerequisite`) |
| `requires.guest.executables` | absolute paths of Linux programs that must exist in the image |
| `mounts`, `state.durable` | guest paths the module reads and writes: shown on the consent card, not enforced |
| `guestFiles` | artifacts written into the guest before the adapter starts, `{ artifact, to, mode? }`; each is replaced atomically (mode `0644` unless given) and a start that cannot write one exits `120` |
| `limits` | `clients` (connections a service serves at once, default 4; a client that connects and stays silent keeps its slot until it closes, because the runner sets no idle timeout, so an adapter that needs one closes idle connections itself) and `startupMs` |
| `options` | typed options for the consumer: `boolean`, `integer`, `string`, `enum`, `enum-set`, each with an optional default |
| `license` | an SPDX expression, `notices` (artifact names), and `source` (required when the license is copyleft) |
| `upstream` | the third-party components the release carries, `{ name, version, source }` with an `https` source: up to 64, as many as a release has artifacts |

### Build, test, release

```sh
pnpm run check    # tsc, eslint, and oxidevm wasm build --check
pnpm test         # your unit tests
oxidevm wasm build
```

`oxidevm wasm build` bundles the adapter into one self-contained `adapter.mjs`
(imports of the SDK other than `defineModule` are refused, and third-party code
you bundle is listed), pins every artifact, and writes `module.json`, `adapter.mjs`,
the artifacts and `SHA256SUMS` to `dist/`. It exits `3` with located findings when
something is wrong, and writes nothing. Warnings (a dependency that mentions
`window`, `import.meta` or `eval`; a bundled package your `license.spdx` does not
name) do not stop the build, but read them. `--check` verifies without writing.

Unit tests run the module through the SDK's real runner, without a browser, with
`testHost` from `@oxidevm/sdk/wasm/testing`:

```ts
import { testHost } from "@oxidevm/sdk/wasm/testing";
import definition from "../module.ts";

const result = await testHost(definition, { args: ["2", "3"], artifacts: { "add.wasm": bytes } }).run();
// { status: 0, stdout: "5\n", stderr: "", files: {...} }
```

It takes `args`, `env`, `cwd`, `invocation`, `terminals`, `stdin`, `files`,
`options`, `artifacts` and `net`. The network is local-only unless
`net.connected` is set, and then serves `net.http` handlers by origin (and
`net.vm` handlers by port inside the VM), with the same reach checks and errors
as the browser; a run ends with `status`, `stdout`, `stderr`, `files` and the
`signal` it ended by, if any.

Blocking clients (`host.net.connectSync`, an interpreter's own sockets) block in
`testHost` as they do in the browser: a read waits until bytes arrive, the
stream ends or its `timeoutMs` passes. A request handler answers
asynchronously, which a blocking read cannot wait for in the same thread, so
serve blocking clients from `net.tcp`: raw TCP services by `host:port`
(`TestTcpService`), whose `data(connection, bytes)` answers at once with
`connection.write`, ends with `connection.end()`, or answers later with
`connection.after(ms, action)` on the network's own clock, which moves only
while a client waits. A read that nothing will ever answer fails with
`FEATURE_NOT_AVAILABLE` (`testhost-blocked-read`) instead of hanging the test.

```ts
const result = await testHost(definition, { net: { connected: true, tcp: {
  "db.example.com:443": { data: (connection, bytes) => { connection.after(50, () => { connection.write(bytes); }); } },
} } }).run();
```

Then test the build in a real browser:

```sh
oxidevm wasm test
oxidevm wasm test --arg 2 --arg 3
oxidevm wasm test --image image/dist --image-trust image/author.public.json
```

`oxidevm wasm test` starts the module in a Userspace VM with the pinned engine and
checks the runner's contract, not the module's own behaviour (keep that in your
tests). Every property is `passed`, `failed` or `not-applicable`, with a reason:

| Property | Holds when |
| --- | --- |
| `integrity` | a served copy with one altered adapter byte is refused (`wasm-module-integrity`) before any module code runs |
| `exit-range` | a command exits with a status from 0 to 119 (`--arg` passes its arguments) |
| `ready` | a service writes its ready line and its endpoints match `expose` |
| `endpoints` | every endpoint accepts a connection |
| `duplicate-start` | a second start beside the first is refused with status `124` |
| `snapshot-refused` | a restore point is refused while the module runs and works after it stops |
| `eof-stop` | the service exits `0` within 20 seconds of the end of its input |
| `restart` | the service starts and serves again after a stop |
| `kill-recover` | the service starts and serves again after a kill, replacing its stale socket |
| `declared-host` | the adapter reached for no host member its `requires.host` did not declare |
| `network-direct` | the module used no browser network API (they are refused in the module frame) |
| `network-declared` | the module connected to nothing beyond its declared reach |
| `network-offline` | with the VM local-only (as it is during the test), a command with your `--arg`s ends with a status from 0 to 119 and, when it fails, a line on standard error; a service stays ready. It applies to every module, with a reach or without one: the VM is local-only for both |

The runner reports an undeclared member once, as a `{"oxidevm":"warning",...}`
line on standard error, and still hands the adapter `undefined` for it. Without
`--image` the test boots the public starter image; name another with `--image`
when the module needs programs the starter does not have. `--option name=value`
sets an option (a JSON number, boolean or array stays typed).

A run ends in one of three results, which `--json` reports as `result` and the
exit status repeats:

| Result | Exit | Means |
| --- | --- | --- |
| `passed` | `0` | every applicable property passed |
| `failed` | `3` | at least one property failed |
| `refused` | `4` | the browser or image cannot run the module at all, so no property ran; every property is `not-applicable` and `refusal` says why |

A refusal is `FEATURE_NOT_AVAILABLE` from `spawnModule`, with one of two closed
reasons: `wasm-module-isolation-unavailable` with the `capability` that failed
(for example `blob-workers` in a browser that cannot start a worker from a
`blob:` URL; the module frame, engine ADR 0028, never falls back to the page's
origin), or `wasm-module-prerequisite` with what is `missing` (a browser
feature or guest executable the manifest requires). Text output prints one
`REFUSED` line instead of the property list. Refused is not a failure of the
module: run it in a browser or with an image that has what it needs. A report
that passed or failed is unchanged (`schemaVersion` 1, no `refusal` field).
Errors before the browser runs (an invalid `dist/`, no browser) still exit `1`
or `2` with an error report.

Release by tag. `oxidevm wasm release` builds and prints the steps; it runs none:

1. tag the commit `v<version>` and push the tag;
2. `gh release create` a **draft** with every file in `dist/`;
3. download the draft and run `sha256sum --check SHA256SUMS`; the digest of
   `SHA256SUMS` itself is the release id the build printed;
4. publish the draft.

The generated `release.yml` does exactly this on a tag push: one job with a
read-only token installs and builds, and a second job that installs nothing holds
the write permission and drafts, verifies and publishes. A CLI whose packages
come from a private registry that GitHub's runners cannot reach generates both
workflows to start on request only and says so at the top of each file; give them
the push or tag trigger once the packages install from a registry the runner can
reach, or follow the same four steps by hand. Consumers install
with `oxidevm wasm add github:owner/repo@v<version>`.

### Licenses

State the license of what you ship in `license.spdx`. A copyleft module (GPL,
LGPL, MPL and similar) must set `license.source` to where the complete source
is, and the release should carry the notices of everything bundled in an artifact
named in `license.notices`. Mirror upstream binaries byte for byte and record where
they came from; do not edit them.

## Reference

| Command | Purpose |
| --- | --- |
| `oxidevm wasm add <source>` | resolve, review, install |
| `oxidevm wasm stage` | rebuild staged files and handles from the lock |
| `oxidevm wasm doctor` | check the project and the engine, list what each module needs from the browser and the image, and note the commands modules declare |
| `oxidevm wasm inspect <file.wasm>` | imports, exports, memory and the ABI a binary appears to use |
| `oxidevm wasm init <directory>` | create a module project; `--network none\|vm\|internet` declares its reach (default `none`) |
| `oxidevm wasm build` | build `dist/` from `module.ts`; `--check` writes nothing |
| `oxidevm wasm test` | run the runner-contract properties against `dist/` in a real browser |
| `oxidevm wasm release` | build, then print the steps that publish it |

Every command accepts `--json`. Exit status `0` is success, `2` an invalid
argument or unavailable feature, `3` a failed report (doctor, build, release, test), `130`
and `143` an interrupt.
