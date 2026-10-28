# Trusted JS processes in Userspace

Run trusted JavaScript workers alongside Linux processes. Workers use the
SDK's validated filesystem, networking and process APIs. These workers do not
provide Node or Bun compatibility.

Userspace enables the packaged TypeScript interceptor by default when the page
is cross-origin isolated. This also works inside the hosted runtime frame, which
loads its own trusted worker. Set `interceptors: false` to keep all commands in
Linux. Without cross-origin isolation, automatic interception is not admitted and
commands run in Linux. Custom worker URLs remain self-hosted only.

The initial handler matches only the managed TypeScript 6.0.2 entrypoint and
`--noEmit` invocation. Different versions, paths or arguments run in Linux.
The worker authenticates the installed compiler before executing. Once admitted,
worker failure exits 125 and never retries in Linux. This applies to the
standalone compiler command.

The normal SDK build authenticates and bundles TypeScript from its pinned build
dependency. Published SDK packages include the worker, compiler license and
provenance. Application bundlers include its asset through a static `new URL`.
No guest image cache, sibling checkout or development server is required.
`typescriptInterceptor()` returns the packaged worker configuration for callers
using the diagnostics runtime. Ordinary `createVM` callers need no configuration.

Use a self-hosted Userspace VM, cross-origin isolation and a trusted worker
bundled by your application. The worker URL must have the runtime's origin.
The initial profile uses uid/gid 1000, initial namespaces, the root allocation
group, no seccomp filter and an unlimited file-size rlimit. Other profiles fail
explicitly. Bridge socket access follows the VM's existing configuration. Local
networking is the default. External connections require the existing relay.

## Launch and lifecycle

```ts
import type { UserspaceVM } from "@oxidevm/sdk";

async function run(vm: UserspaceVM, worker: URL) {
  const process = await vm.spawnJS({ worker, args: ["hello"], cwd: "/workspace" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exit,
  ]);
  return { stdout, stderr, exit };
}
```

`spawnJS({ worker, args?, cwd?, env?, terminal?, signal? })` returns the existing
`ProcessHandle`. With `terminal`, it returns `TerminalHandle` and uses a Rust
PTY. Arguments and environment are available through `context.process.info()`.
The default cwd is `/workspace`. Environment handling follows `spawn`.

`signal` cancels process creation. Cancellation waits for an admitted process
to retire. After creation, use `kill`, `interrupt` or the handle's other
lifecycle methods. Rust termination retires the worker. Worker construction,
execution or transport failure exits 125. A successful handler returns an
integer from 0 to 255, or returns nothing for status 0. An admitted command
never retries in Linux.
Named synchronous and asynchronous handlers can return `void`. Handler results
start as `unknown` and are validated before the worker publishes an exit.

SIGSTOP stops Linux effects and completion delivery until SIGCONT. It does
not suspend arbitrary JavaScript computation in V8. SIGKILL retires the worker.
Snapshots and suspend fail with `FEATURE_NOT_AVAILABLE` and
`detail.reason: "js-process-active"` while any JS process remains alive.
VM disposal closes workers and pending operations.

## Worker context

```ts
import { serveProcess } from "@oxidevm/sdk/js-process";

serveProcess(async ({ files, process, stdout }) => {
  const info = await process.info();
  await files.writeFile("/workspace/from-js.txt", new TextEncoder().encode(info.cwd));
  await files.writeAll(stdout, new TextEncoder().encode("Written through Rust.\n"));
  return 0;
});
```

Call `serveProcess(handler)` once in a dedicated module worker. Its
`LinuxProcessContext` exposes the following operations.

| Owner | Methods |
| --- | --- |
| `files`, `filesSync` | `open`, `read`, `write`, `seek`, `close`, `dup`, `pipe`, `stat`, `lstat`, `fstat`, `readdir`, `realpath`, `mkdir`, `rename`, `unlink`, `fsync`, `readFile`, `writeFile`, `writeAll` |
| `sockets` | `socket`, `connect`, `bind`, `listen`, `accept`, `address`, `read`, `write`, `shutdown`, `close` |
| `process` | `info`, `cwd`, `chdir`, `spawn`, `wait`, `signal` |
| Inherited descriptors | `stdin`, `stdout`, `stderr` |

`files` and the socket/process methods are asynchronous. `filesSync` uses a
shared-memory mailbox with the same Rust operations. Prefer asynchronous calls
for general programs. The compiler needs synchronous filesystem and output
calls. Only the caller's worker waits on its mailbox. The guest scheduler
continues to run. The worker counts each request in the mailbox before posting
it (JS process protocol 2), so a running guest slice ends at its next action
boundary to receive it instead of running out first. Build the worker with the
same SDK version as the runtime; a worker on another protocol is rejected.

Descriptors are branded `FileDescriptor` values owned by the admitted Linux
process. `open` accepts Linux x86-64 flags and mode bits. It defaults to read
only and mode 0666. Rust applies umask, permissions and path resolution.
Paths can be UTF-8 strings or raw bytes. Directory entries include raw name
bytes. `seek` uses a signed `bigint` offset. `dup` shares an open description
and its offset. `write` and `read` preserve short I/O. Empty reads mean EOF.
`writeAll` loops over partial writes. `readFile` defaults to a 16 MiB limit.
`writeFile` creates or truncates a file. Use `fsync` when durability is required.

TCP accepts numeric IPv4 and IPv6 addresses. Unix stream sockets use guest
paths. `address(fd, true)` queries the peer. `shutdown` supports `"read"`,
`"write"` and `"both"`. Sockets share the ordinary file descriptor table.
Network revocation uses the native network owner.

`process.spawn` runs a real guest executable through the existing ELF runtime.
Specify an executable path. The adapter does not perform PATH lookup. The
child inherits credentials, namespace, umask, descriptors and cwd. Its
environment inherits from the JS parent unless `env` is supplied. Each stdio
stream can be `"inherit"` or `"pipe"`. Piped descriptors belong to the parent.
Drain child output while writing large inputs. Call `wait(child.pid)` to reap
the child. Signals use Linux signal numbers. A second wait fails with ECHILD.

`LinuxError.errno` reports a Linux failure. `VMError` reports a transport or
SDK failure. Cancellable open/read/write, socket connect/accept and child wait
accept `{ signal }`. Cancellation is an ordered Rust request. A completed
operation can win the race. An interrupted operation reports EINTR. Do not
retry a mutation after an ambiguous transport failure.

The transport bounds individual I/O at 16 MiB. Rust admits eight outstanding
ordinary requests plus two cancellation requests per process. At most four
JS processes can run at once. Limits fail explicitly. These bounds do not
account for V8 CPU or heap consumption.

## Ownership and diagnostics

Rust binds every request to a runtime generation, process incarnation, PID
and monotonic sequence. It owns descriptors, credentials, paths, permissions,
resource checks, children, pending operations, readiness, signals and exits.
Guest syscalls and JS calls share the same file, socket and process owners.
The JS adapter encodes requests and manages worker transport promises. It
does not implement Linux policy or a second process manager.

The internal launch record is OXCR version 2. JS requests and completions use
OXJR/OXJP version 1. Fields, lengths, identities and operation payloads are
validated before effects. Stale completions cannot affect a successor.
Compiler-only filesystem requests are no longer accepted.

`@oxidevm/sdk/diagnostics` exports `configureJSProcessTrace(vm, capacity)` and
`readJSProcessTrace(vm)`. Traces include bounded capture counts, monotonic
events, process/request/operation identities and errno. They do not invent an
x86 RIP for JS operations or record file contents. Native replay journals the
boundary records but cannot capture or replay a live V8 heap.

Use the diagnostic traces to inspect worker operations and native process
boundaries in your application.
