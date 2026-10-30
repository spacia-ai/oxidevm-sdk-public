# API reference

The emitted declarations in `@oxidevm/sdk` are the canonical public types. Root,
machine and diagnostics imports are safe during SSR; constructing a VM or machine
requires a browser. Image-builder functions are Node-only. Package exports prohibit
consumer imports of private runtime modules.

## Managed VMs

`createVM({ mode: "userspace" })` returns `Promise<UserspaceVM>`;
`createVM({ mode: "system" })` returns `Promise<SystemVM>`. A union option returns
`Promise<VM>`. Neither mode silently falls back to the other.

| Option | Behavior |
| --- | --- |
| `mode` | Required: `userspace` or `system` |
| `image` | Supply a mode-matching `defineImage` reference. This release has no managed defaults |
| `imagePreparation` | `"on-demand"` by default; `"before-ready"` installs the actual selected image durably before admitting guest execution |
| `workspaceId` | Omitted means ephemeral; present requests exclusive durable activation on the application origin |
| `memoryMiB` | Explicit validated allocation or the image's recommendation |
| `runtime.baseUrl` | Relocates the exact pinned platform assets; it cannot select another engine |
| `network` | Defaults to `{ mode: "local" }`; `{ mode: "relay", connection }` connects `vm.network` with that relay connection after the VM is ready and before creation resolves |
| `preview` | Configure a separate origin with `isolation: "per-session"`; shared development requires `developmentOnly: true` |
| `signal` | Cancels creation only, with rollback; it does not own a successfully created VM |
| `onProgress` | Reports loading, validation, boot/restore and ready phases |
| `restorePoint` in either mode | Explicit managed restore point strategy; see the emitted `ManagedResume` union and usage examples |
| System `vcpus` | Default 1; the current release explicitly rejects unqualified higher counts |
| Userspace `limits.maxProcesses` | Explicit bounded override of the signed image recommendation, or 32 when neither is supplied; native process admission includes descendants |
| Userspace `initialUser` | `"user"` (uid/gid 1000) by default; explicit `"root"` starts with Linux root credentials |
| Userspace `rootPersistence` | `"ephemeral"` by default; `"persistent"` requires an explicit `workspaceId` and durable browser storage for writable system files |

Resolved creation means the VFS is mounted or the System agent has answered.
Immediate workspace and process operations can use the returned VM. Creation
failure disposes resources and releases acquired activation leases. If that cleanup
also fails, the original error keeps its code and reports `detail.cleanupFailed`.

`vm.prepareImage({ signal? })` explicitly prepares or repairs the currently selected
image in either mode. It preserves its version, processes and terminals, downloads
only missing or damaged dependencies, and retains verified progress on cancellation.
With `imagePreparation: "before-ready"`, subsequent saves, restores and guest image
reads use local data; missing dependencies report `STORAGE_ERROR` with
`detail.reason: "image-not-cached"` rather than starting an implicit download.
`onProgress` uses `phase: "prepare-image"` with `stage: "download" | "verify" |
"commit"` and byte progress. Preparation events include the manifest identity,
acquisition reason and consumed download-byte/request counters. An `image-prepared`
event is not a checkpoint commit. See [installation and legacy packs](images.md).

Persistent root files are scoped to the workspace and exact rootfs identity.
They cover `/var`, `/etc`, `/srv`, and `/usr/local`; `/run`, `/tmp`, sockets,
devices and live kernel objects restart fresh. The existing workspace save remains
separate. System creation rejects these Userspace-only options.

## Workspace

The VM's `workspace` exposes `readFile`, `writeFile`, `readText`, `writeText`, `list`
and `remove`, and the versioned file operations below. Paths address `/workspace`: `note.txt` and `/note.txt` refer to the
same file. Traversal and symlinks must not escape that scope. Guest executable and
process `cwd` paths are separately validated guest paths.

Writes own a copy of caller bytes and resolve after commit. Binary reads return
bytes; text helpers use UTF-8. `remove` supports explicit recursive removal.

For editors, the workspace also exposes the file owner's versioned operations,
the same methods and types as the diagnostics `RuntimeVM.workspace`:

- `entries(path?, signal?)` and `stat(path, signal?)` return `WorkspaceFileEntry`
  values: `kind` (`file`, `directory` or `symlink`), `link` (a symlink's target
  kind and resolved path, otherwise `null`), `name`, `path`, `size` and a
  48-hex-digit content `version`.
- `read(path, { maxBytes?, signal? })` returns a `WorkspaceFile` (`{ entry, data }`).
  `maxBytes` defaults to and may not exceed 16 MiB; a larger file fails with
  `STORAGE_ERROR` and `detail.reason: "too-large"`.
- `write(path, data, { ifVersion?, signal? })` writes at most 16 MiB and returns the
  new entry. `ifVersion: "<version>"` writes only over that version
  (`STORAGE_ERROR`, `version-mismatch`); `ifVersion: null` creates only a new file
  (`STORAGE_ERROR`, `exists`).
- `createDirectory(path, { signal? })` and `rename(from, to, { signal? })`.
- `watch(onChange, { signal })` returns a `WorkspaceWatch`. `setDirectories(paths)`
  replaces the watched directories (at most 256 per VM). `onChange` receives
  batches of `WorkspaceChange`: `{ kind: "changed", directory, name }` or
  `{ kind: "rescan" }`, which means "read the watched directories again". Aborting
  `signal` ends the watch and resolves `done`; a failed watch rejects `done`.

A System image whose guest agent lacks file operations fails these methods
with `FEATURE_NOT_AVAILABLE` (`detail.reason: "image-update-required"`), as does a
Userspace VM without a root filesystem (`"no-root-filesystem"`). In frame
mode every method runs in the runtime frame's workspace; aborting a signal cancels
the request there, and a lost frame fails pending calls and ends watches with
`PROTOCOL_ERROR`. The types are exported from `@oxidevm/sdk`:
`WorkspaceFileEntry`, `WorkspaceFile`, `WorkspaceChange`, `WorkspaceWatch`,
`WorkspaceReadOptions`, `WorkspaceWriteOptions`, `WorkspaceOperationOptions` and
`WorkspaceWatchOptions`.
### A saved Userspace workspace on another image

A durable Userspace workspace records what the user changed in `/workspace`
against the image it ran on. When it opens on a different image (a new default
image, or another `image`), those changes are carried onto the new image's
`/workspace` instead of failing: paths the user did not change come from the new
image, and the user's own changes stay. `vm.start.workspaceDetails` reports the outcome
in System's words:

- `state: "in-sync"`: nothing was saved, or it was saved on this image;
- `state: "reconciled"`: it was saved on another image and carried over cleanly;
- `state: "conflict-preserved"`: see `conflicts` and `preserved`.

Each entry of `conflicts` (at most 256; `omittedConflicts` counts the rest) names a
`/workspace` path and a `reason`: `changed-in-both` (the new image changed it too;
the user's version stayed), `base-unknown` (the image it was saved on is no
longer known in this browser and the user's version differs from the new one; it
stayed) or `content-unavailable` (the user's version named a file of the earlier
image this browser no longer holds; the new image's version stayed). `preserved:
{ id, reason }` means the earlier save was kept byte for byte in the workspace's
overlay store (under `preserved/<id>/`) before the workspace changed:
`unreadable` (its records were missing, corrupt or in an unreadable format) and
`unreplayable` (it could not be applied to this image) boot the image's own
`/workspace`, as does `base-unavailable` (a whole-tree save from an image this
browser no longer knows); `content-unavailable` keeps the rest of the save. A
damaged save never stops the VM from starting.

`workspace.persistence` describes ephemeral or durable backing, backend and
browser retention. An explicitly durable workspace never becomes an in-memory
success. Browser retention is separate from a committed write and does not make
the browser immune to quota, user deletion or hardware failure.

## Processes

`exec(spec)` closes stdin, drains stdout/stderr concurrently, waits for the actual
exit and returns `{ stdout, stderr, exit }`. The default combined output cap is
1 MiB; `maxOutputBytes` changes the validated cap. Abort and overflow terminate
the admitted process group and await cleanup. A lost process owner is reported
as a cleanup failure rather than a fabricated exit receipt.

`spawn(spec)` returns a pipe process with `stdin`, `stdout`, `stderr`, `exit`, `pid`
and `kill`. With `terminal: { columns, rows }`, it returns a terminal with `stdin`,
one `output` stream, `exit`, `pid`, `kill`, `resize` and `interrupt`.
Terminal handles have no pipe-only stdout/stderr members.

Guest processes default to `HOME=/workspace` and the standard Linux command
search path, including `/usr/local/bin`. Values in `spec.env` override these
defaults, including explicit empty strings.

`ProcessExit` is `{ kind: "exited", code }` or
`{ kind: "signaled", signal, signalNumber }`. Unnamed real-time signals retain
their exact number and have a null name. `kill` defaults to SIGTERM and process
scope; process-group scope is explicit. Valid signals after a confirmed exit are
harmless and cannot target a reused PID. Process creation abort is separate from
the admitted handle's later lifetime.

The caller must consume spawned output and supervise stream failures. Closing a
renderer does not retire its shell. A terminal's `interrupt` addresses the real
foreground group and leaves the shell available when guest behavior permits.

## Networking and previews

Guest sockets are local by default. `vm.network` is the VM's relay owner for guest
internet access, the same object for the VM's lifetime:

| Member | Behavior |
| --- | --- |
| `state` | `off`, `discovering`, `awaiting-approval` (with the six-digit pairing `code`), `connecting`, `connected` or `failed` with a `RelayFailureReason` |
| `connect(connection, { signal })` | Resolves once the relay session and the runtime's transport are ready; failure leaves internet off |
| `disconnect()` | Idempotent; revokes access while files, processes, terminals and previews keep working |
| `watch(onChange, { signal })` | Reports the current state immediately, then each change; resolves when the signal aborts or the VM is disposed, and rejects if `onChange` throws |

`RelayConnectionOptions` is `{ kind: "personal", workspaceName? }` for the relay the
user runs on their own computer, or `{ kind: "server", url, sessionUrl?, headers? }`
for your application's authenticated relay. Server URLs require HTTPS (or HTTP on
`localhost` or `127.0.0.1`) without credentials; a relative `sessionUrl` resolves
against the page; `headers` carry only browser-safe application credentials. Personal
options accept no URL or headers. Invalid options reject with `INVALID_ARGUMENT`. A
failed connection rejects with `RELAY_ERROR`, `PERMISSION_DENIED`, `QUOTA_EXCEEDED` or
`PROTOCOL_ERROR`, and `detail.reason` names the exact `RelayFailureReason`.

With `network: { mode: "relay", connection }`, creation connects exactly once through
the same `vm.network.connect` after the VM is ready; a failure or cancellation disposes
the VM and rejects with that error. Creation cannot show the personal pairing code, so
create such a VM locally, watch `vm.network` and connect it yourself. Restoring a
restore point, `suspend` and disposal revoke access; restore points and backups never
retain it.

`listeningPorts`, `watchListeningPorts` and `exposePort` use real guest listeners.
Port admission validates 1–65535 and configured transport. Exposing a port waits
for the guest listener and transport, then returns a route with a URL and `close`.
Repeated exposures of the same port share an owner until the final handle closes.
Closing a route does not stop its server. VM disposal releases owned routes.
An aborted watch resolves; transport and callback faults reject.

Production preview bootstrap and Service Worker transport run on a distinct
per-session origin. Cookies and storage must remain separated between sessions.
The shared-origin option is a deliberate development configuration. See the
[deployment guide](deployment.md) for static files, headers and route ownership.

A guest server sees a preview request the way a developer's own browser sends it
to the server on their machine, in Userspace and System alike, so development
servers work without `allowedHosts`, `allowedDevOrigins` or similar settings:

- `Host` is `localhost:<port>` for requests and WebSocket upgrades;
- `Origin` and `Referer` naming the session origin become `http://localhost:<port>`
  (Referer keeps its path and query); other origins pass unchanged, and a WebSocket
  upgrade always carries `Origin: http://localhost:<port>`;
- `X-Forwarded-Proto` and `X-Forwarded-Host` name the session origin, for servers that
  build public URLs behind a proxy;
- in responses, absolute `http://localhost:<port>`, `http://127.0.0.1:<port>` and
  `http://[::1]:<port>` URLs in `Location`, `Content-Location`, `Refresh` and
  `Access-Control-Allow-Origin` point back at the session origin. Other ports and
  response bodies are not rewritten.

A cookie the guest sets with `Domain=localhost` is kept as a host-only cookie of the
session origin, and `Secure` cookies are kept as a browser on `localhost` keeps them.

## VM restore points

Both VM modes expose the common `VMStart` and `VMSnapshots` contracts, plus
`suspend`. `SystemStart` and `SystemSnapshots` remain type aliases. Check
`vm.capabilities.snapshots` before offering restore controls. Native Userspace
restore points are experimental in this version. Unavailable browser capabilities fail with
`FEATURE_NOT_AVAILABLE`. A snapshot from the other mode fails with `runtime-mismatch`.

`vm.capabilities.commandAcceleration` reports native JavaScript command acceleration for the VM.
It is `{ available: true }` only when the runtime opened its native execution. It is
`{ available: false, reason: "not-configured" }` under `commandInterceptors: "off"`,
`{ available: false, reason: "mode-unsupported" }` in System mode, and
`{ available: false, reason: "runtime-unsupported" }` when `"auto"` opened without a published
descriptor (see [JavaScript acceleration](acceleration.md)).

`snapshots` offers `list`, `capture`, `restore`, `rename`, `delete`, `usage`,
`observe`, `setAppData`, `autoSave`, `export`, `inspect` and `import`.
Restore saves the current state as a safety point by default. App data is bounded
to 1 MiB; automatic saving starts disabled. Backup import, export and inspection
validate format, image, machine, workspace and retained-base identity.

`suspend` captures consistent state and releases resources and the workspace
lease before returning. Failed suspension leaves the VM available when the
owner can preserve it. Explicit restore failure does not turn into an apparently
successful cold boot. `latest` reports the actual start outcome and skipped
incompatible points. Formats remain experimental in this alpha.

## Images and Node tools

`defineImage({ mode, manifestUrl, manifestSHA256, trust })` creates an immutable,
mode-branded reference. The key is an external Ed25519 SPKI anchor, not a key
obtained from the downloaded image. Both managed modes authenticate the whole
manifest and its referenced artifact closure before execution.

In an explicit-image release, `defaultImage` fails with `FEATURE_NOT_AVAILABLE`.
Older catalog-schema releases retain the following managed-image behavior.

`defaultImage(mode, manifestUrl?)` returns the SDK's pinned default image for a
mode: the exact manifest digest and author key this SDK version pins, at its
default address or at `manifestUrl` when you serve the same image from another
host. The digest and key stay pinned whatever the address.

| Image-builder operation | Purpose |
| --- | --- |
| `loadImageRecipe` | Load a trusted local recipe and decode its export from unknown |
| `buildImage` | Build a mode-specific signed image from recipe-owned paths |
| `generateImageKey`, `readImageTrust` | Exclusive restrictive Ed25519 key creation and public trust loading |
| `testImage` | Real browser readiness, files, command, terminal, persistence and applicable preview/evidence checks |
| `inspectImage` | Read-only integrity inspection; authentication stays unverified without external trust |
| `installProjectAssets`, `cacheImageBundle` | Stage the pinned engine release (from `engineDir`, `OXIDEVM_ENGINE_DIR`, the engine cache or the verified CDN release), authenticated image assets and generated references |
| `doctorProject` | Inspect actual served headers, MIME, bytes, worker execution, storage and preview configuration |
| `createProjectLock`, `validateProjectLock` | Bind the exact SDK/CLI, engine, image and chosen staging layout |

Dockerfile, OCI, directory and archive rootfs sources work in both modes.
`boot-files` is system-only. Development builds are signed and list missing
distribution evidence. Distribution builds require separate reviewed evidence
and two actual independent reproductions; passing browser qualification remains
a separate required release gate.

## Raw and advanced entry points

`bootMachine` accepts byte-array kernel/boot specifications and exposes consoles,
pause, resume and disposal. It does not invent a managed workspace, `exec`, agent
readiness or shell-ready result. The second agent console remains an internal
transport. It takes the same `network` option: a relay connects after the machine is
configured and before execution starts, and disposal revokes it; a failed connection
disposes the machine and rejects with the relay's error.

`eraseLocalData({ runtime?, signal? })` (diagnostics entry) erases every OxideVM
workspace, restore point, image and IndexedDB store of the origin that runs the
runtime. Without `runtime`, or with a self-hosted one, that is this page's origin.
With `runtime: { hosting: "frame", origin? }` it is the runtime frame's origin, whose
storage partition the page cannot reach itself: a hidden frame of its own disposes
any VM it created and erases there. Dispose every VM first; a workspace still
active in another tab or frame fails the call with `STORAGE_ERROR`
(`detail.reason: "local-data-in-use"`) before anything is erased.

`getDiagnostics(vm)` returns the existing diagnostic owner for an ordinary VM.
The diagnostics entry also preserves the embedding application's advanced APIs and admitted
assistance; ordinary applications should use the root surface. Native Core,
Userspace, guest-agent, worker and trace versions travel with the exact staged
descriptor; the diagnostics entry exports the pinned `engineRelease`, its
`engineReleaseId` and `RELAY_VERSION`, the relay protocol version the SDK speaks,
which an engine compares with its own relay specification. There is one
execution, VFS, JIT and process authority.

Workspace handoff is opt-in in both modes. A holder calls
`vm.allowWorkspaceHandoff(onMovedAway, { signal })` returns a promise that lasts
until the subscription ends; handle its typed registration errors. Aborting that signal revokes
future requests. A requester calls
`requestWorkspaceHandoff(workspaceId, { runtime, signal, timeoutMs })` before
creating its VM. Use the same runtime selection for both calls. Hosted requests
run on the runtime frame's storage origin. A failed save rejects the requester
with the holder's typed error and leaves the holder running; `"no-response"`
means no holder answered before the timeout. Handoff does not bypass snapshot
availability or release gates.

`createVM({ mode, image, workspaceId, restorePoint: "latest", shippedSnapshot: "ready" })`
opts into the named signed start listed by that image, only on the workspace's
first visit. Existing saves take precedence. The image reference supplies the
explicit trusted author key; names, signatures, image identity, runtime mode,
chunk hashes and sizes are checked before publication. Native catalogs use
rootfs manifest schemas 7/8 and schema 3 checkpoint graphs. Older rootfs manifests
remain readable. An unavailable or invalid shipped start is reported through
`vm.start` and never silently changes runtime mode.

Retained starts inspect verified cached source metadata before online image
lookup. `vm.image` identifies the image actually running, including its exact
signed source manifest digest. `vm.start.update`, when known, describes a newer
requested image; selecting `restorePoint: "update-image"` explicitly moves to it.

A Userspace workspace saved on an image signed by another key than the one the app now
configures never boots that saved state. Retained-start inspection fails with
`PROTOCOL_ERROR`, `detail.reason: "image-trust-changed"` and the earlier `detail.keyId`.
Open the workspace with `restorePoint: "update-image"` to move it to the configured image while
keeping the learner's own `/workspace` files, or use another `workspaceId`. A verified image
whose key differs from the supplied trust fails with `detail.reason: "untrusted-key"`.

`vm.image` follows a committed in-place restore, including a restore to an older
verified image. The restore result's `start.update` carries the current update offer.
Process and terminal handles may expose a read-only `snapshotKey` matching their
resumed terminal key; native handles always provide it. Keep this key in app data
to restore tab names and order. Legacy handles can omit it.

`vm.checkForUpdate({ signal? })` verifies only the image configured for this VM and
returns a verified `ImageInfo` offer, or `null`. It never installs an image. Optional
network discovery is separate from startup: a cached resume does not wait for it.
`vm.start.update` remains the offer known at startup; discard a later offer after
disposal or a new session generation. Errors and cancellation use `VMError`.

Enabling `vm.snapshots.autoSave.configure({ enabled: true })` also prepares the
complete native image in the background after startup. Manual-only sessions retain
their default behavior and acquire missing dependencies when saving. Preparation
yields to typing and joins a manual save without duplicate acquisition.
`image-preparation-progress` events carry `completedBytes` and `totalBytes`;
`image-prepared` and `image-preparation-failed` end that preparation attempt.
Preparation never emits `save-finished` or means the session has been saved.
Existing loose images may gain a reclaimable local packed accelerator when quota
permits; original files and checkpoint identities remain intact.

## Experimental JS processes

The paired command-interceptors worktrees add `UserspaceVM.spawnJS` and the
`@oxidevm/sdk/js-process` worker export. See [the API and ownership notes](./js-process.md)
and [the native-child example](../examples/js-process/README.md).
