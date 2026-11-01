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

Modules need a **self-hosted runtime** on a cross-origin isolated page. A module
runs as a JS process of the VM, started by `spawnModule` or by a program that runs
one of its commands, and the hosted frame client runs neither: `spawnModule` and
`enableModuleCommands` take a Userspace VM that `createVM` returned on this page.
A running module uses one JS process, and at most 32 host commands run at once:
JS processes, worker threads, esbuild runs and native commands share that lane.
`oxidevm wasm doctor` lists what each installed module needs from the browser and
the image, which it cannot check itself.

## Use a module

```sh
oxidevm wasm add github:owner/repo@v1.0.0
```

The command resolves the release, shows what the module declares, and asks
before it installs anything. The card says what the module _declares_ because a
module is code that runs in a worker of your page with that authority; it is not
sandboxed from your application. Review it the way you review a dependency. For a
module with commands the card lists each command with its path,
`/usr/local/bin/<name>`, says that a command takes the place of an image program
with the same name, and warns that a module that runs code it is given, such as
an interpreter, lets programs in the VM run code in your page's origin. For a
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
named by the digest of its `SHA256SUMS`. All pinned files are checked again each
time a module starts: a file that no longer matches stops the module before any
module code runs (exit status 121). That is a check at start. A loader that the
adapter hands a `host.artifacts.url(name)` fetches the bytes later, and those
fetches are not checked again.

Module commands are checked once, when they are turned on: `enableModuleCommands`
fetches every pinned file, checks it, and keeps the checked copies, with the
WebAssembly artifacts compiled, for as long as the commands stay on. Every run
uses those copies, so a file that changes on the server afterwards has no effect,
and a file that does not match fails the call before any of its code runs. Turn
the commands off and on again to check again or to pick up a new release. The
copies live in your page's memory: they guard against a server or cache that
changes files later, not against code running in your page.

The pins protect the files, not the code's behavior. `mounts` and `state.durable`
are information for the consent card; nothing enforces them, and an adapter can
touch any file its host operations allow. Once a command is on, every program in
the VM can run it, with every host operation the module declares.

**An interpreter command runs guest code in your page's origin.** A module that
runs code it is given, such as a Python interpreter, lets programs in the VM run
code in your page's origin once its commands are on: a program that runs
`python3 -c "..."` can then send same-origin requests that carry your page's
cookies, and reach its IndexedDB and OPFS data and its BroadcastChannels. Any
program in the VM can do this, including a script that came with a project. A
module that hides its interpreter's bridge to JavaScript from such programs
narrows this path but does not close it. Turn such commands on only where that is
acceptable for your page; the engine's ADR 0027 records this as an accepted
exception until module workers move to a separate origin.

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

A service started with `exclusive: "workspace"` holds a Web Lock named for the
workspace and module, so a second tab fails fast with a busy error instead of
corrupting a database. A service killed without stopping leaves its socket file;
the next start replaces it when nothing is listening on it. If another process
listens there, the start fails as busy and the socket is left alone.

### Run a module's commands from a shell

A command module may declare `commands`, the names under which programs in the
VM run it. Turn them on for one Userspace VM with `enableModuleCommands`:

<!-- typecheck: wasm/commands.ts -->
```ts
import type { UserspaceVM } from "@oxidevm/sdk";
import { enableModuleCommands } from "@oxidevm/sdk/wasm";
import { wordfreq } from "./oxidevm.modules.generated";

export async function shell(vm: UserspaceVM): Promise<void> {
  // Fetches and checks the module's files once, then places /usr/local/bin/wordfreq in this VM.
  const commands = await enableModuleCommands(vm, wordfreq, { concurrency: 2 });
  const path: "/usr/local/bin/wordfreq" = commands.paths.wordfreq;
  for (const { name, reason } of (await commands.status()).skipped) console.warn(`${name} is not on: ${reason}`);

  // Every program in the VM now runs it like any other program, and so does your own code.
  const counted = await vm.exec({ command: "wordfreq", args: ["README.md", "counts.json"], cwd: "/workspace" });
  console.log(path, counted.exit);

  // Off again: the stub is removed and the checked copies are dropped.
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
Commands need what `spawnModule` needs: a Userspace VM that `createVM` made with
a self-hosted engine, a cross-origin isolated page and the default
`initialUser: "user"`.

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
restore; the next placement tries again. `disable()` removes the stubs and drops
the checked copies, while runs that already started finish with theirs. Calling
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

### Bundlers and security policy

The generated handles name staged files with `new URL(path, import.meta.url)`, so
bundlers copy them as assets. Vite inlines files smaller than 4 KiB as `data:`
URLs; both forms work, and the sha256 check applies either way. Set
`assetsInlineLimit: 0` if you want every file served as a file. Development servers rewrite files
they serve as scripts, stylesheets or pages (Vite adds import analysis to a `.mjs`), which would
change the bytes the lock pins, so the handles name the neutral `.bin` copies that staging keeps
beside those files; `oxidevm wasm doctor` checks the copies too. Under a content
security policy, allow `blob:` in `script-src`, because the runner imports the
verified adapter from a blob URL, and allow `data:` in `connect-src` when a
bundler inlines staged files.

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
| `wasm-module-integrity` | `GUEST_CRASH` | a file or the adapter did not match its pinned sha256; `detail.file` names it |
| `wasm-module-artifact` | `CORE_LOAD_FAILED` | a pinned file could not be fetched: the request failed or the server answered with an HTTP error; `detail.file` names it |
| `wasm-module-prerequisite` | `FEATURE_NOT_AVAILABLE` | a declared browser feature or guest executable is missing; `detail.missing` lists them |
| `wasm-module-adapter` | `GUEST_CRASH` | the adapter threw, had the wrong shape, or returned an invalid status |
| `wasm-module-busy` | `QUOTA_EXCEEDED` | another process holds the workspace lock or an endpoint |
| `wasm-module-ready` | `PROTOCOL_ERROR` | the service printed no valid ready line |
| `wasm-module-options` | `INVALID_ARGUMENT` | an option passed to `spawnModule` or `enableModuleCommands` is unknown, has the wrong type or is out of range, or a required one is missing |
| `wasm-module-commands` | `INVALID_ARGUMENT` | `enableModuleCommands` got a service or a module without commands, a `commands` list that is empty, repeats a name or names one the module does not declare, a `concurrency` that is not an integer from 1 to 32, or another field, such as `args`; nothing has been fetched |
| `wasm-module-command-conflict` | `INVALID_ARGUMENT` | another `enableModuleCommands` call already turned on one of the names in this VM |
| `wasm-module-command-unavailable` | `FEATURE_NOT_AVAILABLE` | the VM cannot run module commands: it runs in the hosted runtime frame, was not created by this copy of the SDK, is a System VM, has a root initial user or no image, or the page is not cross-origin isolated; nothing has been fetched |
| `wasm-module-command-limit` | `QUOTA_EXCEEDED` | the VM already has 16 sets of commands on, or would have more than 64 command names or 512 MiB of checked files |
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
| `120` | the module could not be launched, including when a pinned file could not be fetched (`wasm-module-artifact`) |
| `121` | a file or the adapter did not match its pin; never for a command, whose files were checked when it was turned on |
| `122` | a declared browser feature or guest executable is missing |
| `123` | the adapter threw, had the wrong shape, or returned an invalid status |
| `124` | another process holds the service's workspace lock or an endpoint |
| `125` | the engine reports a failed worker |
| `126` | a command's stub ran as an ordinary program and printed why on standard error: the command is not on in this VM, the file is a copy of the stub at another path, the caller does not run as uid and gid 1000 outside a container, or `concurrency` runs or the VM's 32 host commands are already in use |
| `128` + n | signal n ended the process, for example `130` for Ctrl+C; the process handle's `exit` is `{ kind: "signaled" }` |

A command that `disable()` turned off is gone: a shell reports `127` (not found),
or runs the image's program with that name.

## Write a module

```sh
oxidevm wasm init my-tool                  # a command module wrapping a tiny Wasm function
oxidevm wasm init my-db --kind service     # a service listening on a Unix socket
oxidevm wasm init wrapped --from lib.wasm  # start from your own WebAssembly file
```

The project has strict TypeScript and ESLint settings, a unit test, CI and release
workflows, and an `AGENTS.md` for coding agents. Everything lives in `module.ts`
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
  declared artifact names. `compile` and `bytes` return bytes the runner has
  checked; `url` returns where the page serves the file, for a loader that fetches
  it itself, and what such a loader reads is not checked again.
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
| `sockets.connect` | `sockets` | client sockets (listening belongs to the runner) |
| `process.info` | `process.info`, `process.cwd` | this process's id, credentials and directory |
| `process.spawn` | `process.spawn`, `process.wait`, `process.signal` | native child processes |
| `process.signals` | `process.signals` | trap SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1 and SIGUSR2 instead of their default action, and end this process killed by a signal (Userspace API 145) |

Every host also has `signal`, `options`, `artifacts`, `stdio`, `log(line)`,
`fail(status, message)` and `kit`: tested helpers for Linux-to-Emscripten errno
mapping, length-prefixed framing, a FIFO session gate, running a native command
with bounded output, and atomic directory creation. Use the kit instead of
rewriting these; a module never imports it.

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
SIGUSR2 and resolves once they reach the module instead of their default action;
SIGKILL and SIGSTOP never can, and a signal the process inherited as ignored stays
ignored. The trap is an async iterable of the trapped signals as they arrive, and
a signal that arrives again before the module has seen it is delivered once.
`interruptBuffer` is an `Int32Array` in the format that Pyodide's
`setInterruptBuffer` reads. While a signal is trapped, its arrival makes a host
operation that is waiting fail with `EINTR`. `untrap()` gives the signals their
default action back, and `raise(signal)` of a signal that is not trapped ends the
process killed by it, so a shell reports 128 + n; its promise never settles then.
Finish quickly once a trapped signal arrives, then `untrap()` and `raise()` it.

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
| `requires.browser` | `cross-origin-isolated`, `indexeddb`, `jspi`, `web-locks`; checked before the adapter runs |
| `requires.guest.executables` | absolute paths of Linux programs that must exist in the image |
| `mounts`, `state.durable` | guest paths the module reads and writes: shown on the consent card, not enforced |
| `guestFiles` | artifacts written into the guest before the adapter starts, `{ artifact, to, mode? }`; each is replaced atomically (mode `0644` unless given) and a start that cannot write one exits `120` |
| `limits` | `clients` (connections a service serves at once, default 4; a client that connects and stays silent keeps its slot until it closes, because the runner sets no idle timeout, so an adapter that needs one closes idle connections itself) and `startupMs` |
| `options` | typed options for the consumer: `boolean`, `integer`, `string`, `enum`, `enum-set`, each with an optional default |
| `license` | an SPDX expression, `notices` (artifact names), and `source` (required when the license is copyleft) |

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
| `integrity` | a served copy with one altered adapter byte is refused with status `121` |
| `exit-range` | a command exits with a status from 0 to 119 (`--arg` passes its arguments) |
| `ready` | a service writes its ready line and its endpoints match `expose` |
| `endpoints` | every endpoint accepts a connection |
| `duplicate-start` | a second start beside the first is refused with status `124` |
| `snapshot-refused` | a restore point is refused while the module runs and works after it stops |
| `eof-stop` | the service exits `0` within 20 seconds of the end of its input |
| `restart` | the service starts and serves again after a stop |
| `kill-recover` | the service starts and serves again after a kill, replacing its stale socket |
| `declared-host` | the adapter reached for no host member its `requires.host` did not declare |

The runner reports an undeclared member once, as a `{"oxidevm":"warning",...}`
line on standard error, and still hands the adapter `undefined` for it. Without
`--image` the test boots the public starter image; name another with `--image`
when the module needs programs the starter does not have. `--option name=value`
sets an option (a JSON number, boolean or array stays typed). A failed property
exits `3`.

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
| `oxidevm wasm init <directory>` | create a module project |
| `oxidevm wasm build` | build `dist/` from `module.ts`; `--check` writes nothing |
| `oxidevm wasm test` | run the runner-contract properties against `dist/` in a real browser |
| `oxidevm wasm release` | build, then print the steps that publish it |

Every command accepts `--json`. Exit status `0` is success, `2` an invalid
argument or unavailable feature, `3` a failed report (doctor, build, release, test), `130`
and `143` an interrupt.
