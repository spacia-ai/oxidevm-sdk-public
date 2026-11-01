# WebAssembly modules

A module wraps a WebAssembly program (PGlite, Pyodide, a Rust crate compiled to
Wasm) so that an application can install it with one command and run it next to
real Linux programs. The module runs in a Userspace JS process, so it shares the
VM's files, process ids and sockets: a native Python client can connect to a
database the module serves, and the module can read files a Linux program wrote.

A module has three parts, kept in one repository:

- a **manifest**: a literal object that declares everything the module needs
  (host operations, browser features, guest executables, endpoints it listens on,
  options, license);
- an **adapter**: a function that receives only the host operations the manifest
  declared and returns the hooks the runner drives;
- **artifacts**: the WebAssembly files and notices, pinned by sha256.

Modules need a **self-hosted runtime** on a cross-origin isolated page, because
they start JS processes with `UserspaceVM.spawnJS`, which the hosted frame client
does not offer. A running module uses one JS process, and at most 32 host
commands run at once: JS processes, worker threads, esbuild runs and native
commands share that lane. `oxidevm wasm doctor` lists what each installed module
needs from the browser and the image, which it cannot check itself.

## Use a module

```sh
oxidevm wasm add github:owner/repo@v1.0.0
```

The command resolves the release, shows what the module declares, and asks
before it installs anything. The card says what the module _declares_ because a
module is code that runs in a worker of your page with that authority; it is not
sandboxed from your application. Review it the way you review a dependency. For a
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
operation, a new endpoint, a new guest executable) always asks again, even from a
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

The pins protect the files, not the code's behavior. `mounts` and `state.durable`
are information for the consent card; nothing enforces them, and an adapter can
touch any file its host operations allow.

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
with `FEATURE_NOT_AVAILABLE` while a module runs. Stop the modules, capture, and
start them again; a service reopens its durable state.

### Errors

Failures to start are `VMError`s with a stable `detail.reason`:

| Reason | Code | Meaning |
| --- | --- | --- |
| `wasm-module-launch` | `GUEST_CRASH` | the launch descriptor was missing, oversized or invalid |
| `wasm-module-integrity` | `GUEST_CRASH` | a file or the adapter did not match its pinned sha256 |
| `wasm-module-prerequisite` | `FEATURE_NOT_AVAILABLE` | a declared browser feature or guest executable is missing; `detail.missing` lists them |
| `wasm-module-adapter` | `GUEST_CRASH` | the adapter threw, had the wrong shape, or returned an invalid status |
| `wasm-module-busy` | `QUOTA_EXCEEDED` | another process holds the workspace lock or an endpoint |
| `wasm-module-ready` | `PROTOCOL_ERROR` | the service printed no valid ready line |
| `wasm-module-options` | `INVALID_ARGUMENT` | an option is unknown, has the wrong type or is out of range |
| `wasm-manifest-invalid` | `INVALID_ARGUMENT` | a manifest, lock or descriptor failed validation |

A module that ends by itself reports the status it chose: `0`-`119` belong to its
adapter, `120`-`124` to the runner (launch, integrity, prerequisite, adapter,
busy), and `125` to the engine.

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

Every host also has `signal`, `options`, `artifacts`, `stdio`, `log(line)`,
`fail(status, message)` and `kit`: tested helpers for Linux-to-Emscripten errno
mapping, length-prefixed framing, a FIFO session gate, running a native command
with bounded output, and atomic directory creation. Use the kit instead of
rewriting these; a module never imports it.

### Manifest fields

| Field | Meaning |
| --- | --- |
| `id`, `version` | lower-case id (up to 63 characters) and a semantic version |
| `abi` | `wasi`, `component`, `emscripten`, `bindgen` or `raw`; `oxidevm wasm inspect file.wasm` reports what a binary appears to use |
| `artifacts` | `{ name, from }`: files of your repository the release carries |
| `process` | `{ kind: "command" }` or `{ kind: "service", exclusive?: "workspace" }` |
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
| `oxidevm wasm doctor` | check the project and the engine, and list what each module needs from the browser and the image |
| `oxidevm wasm inspect <file.wasm>` | imports, exports, memory and the ABI a binary appears to use |
| `oxidevm wasm init <directory>` | create a module project |
| `oxidevm wasm build` | build `dist/` from `module.ts`; `--check` writes nothing |
| `oxidevm wasm release` | build, then print the steps that publish it |

Every command accepts `--json`. Exit status `0` is success, `2` an invalid
argument or unavailable feature, `3` a failed report (doctor, build, release), `130`
and `143` an interrupt.
