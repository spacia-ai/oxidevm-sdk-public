# OxideVM SDK and CLI: usage guide

Start with the [starter application](../examples/starter/README.md), then use this guide to add files, processes, terminals and previews to your application.

The CLI creates your local web application. Linux programs execute inside the browser when someone opens that application.

| I want to… | Start here |
| --- | --- |
| Try the starter and run a Linux command | [Hello in the browser](#1-hello-in-the-browser) |
| Add OxideVM to my existing frontend | [Existing applications](#2-add-oxidevm-to-an-existing-application) |
| Keep files after reopening the page | [Persistent workspaces](#3-keep-files-between-visits) |
| Run a web application inside the VM | [A guest web app](#4-run-a-web-app-inside-the-browser) |
| Install/build an existing project | [Guest project commands](#5-run-your-projects-commands) |
| Add an interactive terminal | [Terminals](#6-add-an-interactive-terminal) |
| Save and restore a complete Linux session | [Restore points](#7-use-restore-points) |
| Ship my own Linux tools or runtime | [Custom images](#8-create-and-use-your-own-image) |

The examples use these names:

| Name | CLI option | SDK option |
| --- | --- | --- |
| **Userspace** — run supported Linux applications without booting a guest kernel | `--mode userspace` | `mode: "userspace"` |
| **System** — boot a real Linux kernel and run its applications | `--mode system` | `mode: "system"` |

The creator selects Userspace mode and the prebuilt nginx image for the starter. SDK calls use explicit mode and image options. For custom tools and System mode, see [custom images](#8-create-and-use-your-own-image).

## 1. Hello in the browser

### Create the application

```sh
npx --no-install oxidevm init hello-oxidevm --start
```

Open the application URL printed by the development server. The template uses the hosted runtime frame in development and production.

Run this from the prepared private preview's launcher directory. It supplies the prebuilt signed image and runtime automatically. The creator creates a new directory and preserves existing directories.

There are two environments to keep straight:

| Command | Where it runs |
| --- | --- |
| `pnpm dev` in your computer's terminal | Starts your frontend's development server |
| `vm.exec(...)` or `vm.spawn(...)` in browser code | Starts a Linux process inside the browser VM |

### Give the page a Run button

The starter already runs nginx. To replace it with a small command demo, use the generated `src/image.ts` reference and replace `src/main.ts` with this code. It creates its own button and output element.

<!-- typecheck: usage/main.ts -->
```ts
import image from "./image.js";
import { createVM, VMError } from "@oxidevm/sdk";

const button = document.createElement("button");
button.textContent = "Run Linux command";
const output = document.createElement("pre");
document.body.replaceChildren(button, output);

async function runDemo(): Promise<void> {
  button.disabled = true;
  output.textContent = "Starting Userspace…";
  try {
    const vm = await createVM({ mode: "userspace", image, runtime: { hosting: "frame" } });
    try {
      await vm.workspace.writeText("hello.txt", "Hello from Linux in your browser!\n");
      const result = await vm.exec({ command: "cat", args: ["hello.txt"] });
      if (result.exit.kind === "signaled") {
        throw new Error(`cat ended with Linux signal ${result.exit.signalNumber}`);
      }
      if (result.exit.code !== 0) {
        throw new Error(`cat exited ${result.exit.code}: ${new TextDecoder().decode(result.stderr)}`);
      }
      output.textContent = new TextDecoder().decode(result.stdout);
    } finally {
      await vm.dispose();
    }
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", () => {
  void runDemo().catch((error: unknown) => {
    output.textContent = error instanceof VMError
      ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : "The command could not run";
  });
});
```

Click **Run Linux command**. Expected output:

```text
Hello from Linux in your browser!
```

This writes `/workspace/hello.txt`, runs the image's real Linux `cat`, reads its output, and releases the VM. Each click starts a fresh ephemeral workspace.

For System, supply a signed System image with `--mode system`, pass its image reference in the factory, and change the progress label to “Starting System…”. The file and command APIs are the same.

## 2. Add OxideVM to an existing application

Install the browser library and development CLI:

```sh
pnpm add /absolute/path/oxidevm-sdk-<version>.tgz
pnpm add -D /absolute/path/oxidevm-cli-<version>.tgz
```

Replace `<version>` with the version of the packages you received; it is part of the archive names.

Use the pnpm override in [development](development.md) so the CLI resolves the supplied SDK archive.

Create `oxidevm.config.ts` in your project root:

<!-- typecheck: usage/oxidevm.config.ts -->
```ts
import type { ProjectConfig } from "@oxidevm/sdk/image-builder";

export default {
  mode: "userspace",
  publicDir: "public",
  assetBaseUrl: "/oxidevm/",
} satisfies ProjectConfig;
```

For hosted execution, reuse the starter's signed `src/image.ts` reference and
select `runtime: { hosting: "frame" }` in `createVM`. Supply the isolation headers
below. No local engine installation is required.

The following asset installation is for explicit licensed self-hosting. It
stages the pinned runtime and your explicit image assets:

```sh
pnpm exec oxidevm assets install --image /absolute/path/starter --trust /absolute/path/starter.public.json --reference src/generated/minimal.image.ts
```

The first run writes `oxidevm.lock.json`, which binds the exact SDK, CLI, engine and image; commit it. Later runs validate it and never replace it.

The SDK package contains no engine. The command stages the engine release the SDK
pins from `--engine-dir <release>`, `OXIDEVM_ENGINE_DIR`, the local engine cache or,
with `OXIDEVM_DOWNLOAD_TOKEN`, the private release, and verifies it first.

Configure your development server/static host with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve `.wasm` assets as `application/wasm`. If your app has a restrictive CSP, allow the SDK's workers and Wasm compilation as described in the [deployment reference](deployment.md#application-host).

Start your normal development server and check its actual URL:

```sh
pnpm exec oxidevm doctor http://localhost:5173/
```

Use your own port if it differs. The Run-button example above also works in an existing plain TypeScript frontend. In React, Vue, Svelte, or Next.js, call `createVM` from client code and release the VM when the owning view closes. Avoid creating a VM during server rendering.

If you keep a VM open across several interactions, create it once and reuse it for files, processes, and terminals. Calling `createVM` for every keystroke is unnecessary.

Guest commands use `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` and `HOME=/workspace` by default. Override them with `env.PATH` and `env.HOME`; explicit empty values stay empty. Command names and relative paths use the image's own shell and executables, so the image must provide `/bin/sh` for those forms.

## 3. Keep files between visits

Give the VM a stable `workspaceId`. Here is a complete save → close → reopen example:

<!-- typecheck: usage/persistence.ts -->
```ts
import image from "./image.js";
import { createVM } from "@oxidevm/sdk";

export async function saveAndReopen(): Promise<string> {
  const first = await createVM({ mode: "userspace", image, workspaceId: "my-notes" });
  try {
    await first.workspace.writeText("notes.txt", "Keep this after reopening.\n");
  } finally {
    await first.dispose();
  }

  const reopened = await createVM({ mode: "userspace", image, workspaceId: "my-notes" });
  try {
    return await reopened.workspace.readText("notes.txt");
  } finally {
    await reopened.dispose();
  }
}
```

Expected result: `Keep this after reopening.` followed by a newline. The same ID can be used on a later visit to the same application origin.

Workspace paths such as `notes.txt` refer to `/workspace/notes.txt`. Files survive a normal persistent close/reopen; running processes do not automatically resume. Without `workspaceId`, the workspace is ephemeral. Keep one active VM per persistent workspace ID and await its disposal before opening another owner.

You can read bytes with `readFile`, write bytes with `writeFile`, list a directory with `list`, and remove a file with `remove`. The default image supplies the immutable Linux runtime; your workspace holds your project changes.

## 4. Run a web app inside the browser

This example creates a tiny guest Node application, runs `npm run dev`, and exposes port 3000. It needs an image with Node.js and npm. Supply that image's signed reference as `src/image.ts`. The nginx starter image contains neither tool. A Node/npm image with both tools preinstalled needs no guest package download for this example.

**Prerequisite:** configure a preview host using the [preview hosting reference](deployment.md#preview-host). Pass its real origin into `startWebApp`; `https://preview.example.net/` is an example address to replace. Preview setup is separate from starting the guest process.

### A small output helper

Put this in `src/streams.ts`. It turns process bytes into streamed UTF-8 text and provides a reusable helper for finite commands.

<!-- typecheck: usage/streams.ts -->
```ts
import type { ProcessExit, VM } from "@oxidevm/sdk";

export function textSink(render: (text: string) => void): WritableStream<Uint8Array> {
  const decoder = new TextDecoder();
  return new WritableStream<Uint8Array>({
    write: (bytes) => { render(decoder.decode(bytes, { stream: true })); },
    close: () => {
      const tail = decoder.decode();
      if (tail.length > 0) render(tail);
    },
  });
}

export type ProcessCompletion =
  | { readonly kind: "exited"; readonly exit: ProcessExit }
  | { readonly kind: "failed"; readonly error: unknown };

export async function runStreaming(
  vm: VM, command: string, args: readonly string[], render: (text: string) => void,
): Promise<ProcessExit> {
  const process = await vm.spawn({ command, args });
  const input = process.stdin.getWriter();
  try {
    const [exit] = await Promise.all([
      process.exit,
      process.stdout.pipeTo(textSink(render)),
      process.stderr.pipeTo(textSink(render)),
      input.close(),
    ]);
    return exit;
  } finally {
    input.releaseLock();
    await process.kill("SIGKILL", { scope: "process-group" });
  }
}
```

These are helpers in your application, not additional SDK methods. Both output streams are consumed, so a noisy guest command does not stall because nobody reads its stderr.

### Start the app and retain a Stop action

Put this in `src/web-app.ts`:

<!-- typecheck: usage/web-app.ts -->
```ts
import image from "./image.js";
import { createVM } from "@oxidevm/sdk";
import { textSink, type ProcessCompletion } from "./streams.js";

export interface RunningWebApp {
  readonly url: URL;
  readonly finished: Promise<ProcessCompletion>;
  stop(): Promise<void>;
}

export async function startWebApp(
  previewOrigin: string, renderLog: (text: string) => void,
): Promise<RunningWebApp> {
  const vm = await createVM({
    mode: "userspace", image,
    preview: { origin: previewOrigin, isolation: "per-session" },
  });
  try {
    await vm.workspace.writeText("package.json", JSON.stringify({
      name: "hello-guest",
      private: true,
      scripts: { dev: "node server.cjs" },
    }, null, 2));
    await vm.workspace.writeText("server.cjs", [
      'const http = require("node:http");',
      'http.createServer((_request, response) => {',
      '  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });',
      '  response.end("Hello from the guest Node app!\\n");',
      '}).listen(3000, "0.0.0.0", () => console.log("Listening on 3000"));',
    ].join("\n"));

    const process = await vm.spawn({ command: "npm", args: ["run", "dev"] });
    const input = process.stdin.getWriter();
    const lifetime = Promise.all([
      process.exit,
      process.stdout.pipeTo(textSink(renderLog)),
      process.stderr.pipeTo(textSink(renderLog)),
      input.close().finally(() => { input.releaseLock(); }),
    ]);
    const finished: Promise<ProcessCompletion> = lifetime.then(
      ([exit]) => ({ kind: "exited", exit }),
      (error: unknown) => ({ kind: "failed", error }),
    );
    const preview = await vm.exposePort(3000, {
      signal: AbortSignal.timeout(120_000),
    });
    return {
      url: preview.url,
      finished,
      stop: async () => {
        await vm.dispose();
        await finished;
      },
    };
  } catch (error: unknown) {
    await vm.dispose();
    throw error;
  }
}
```

`startWebApp` returns the preview URL after the listener and route are ready. Put that URL into your preview iframe or link. The page should show:

```text
Hello from the guest Node app!
```

Keep the returned `RunningWebApp` while the app is visible. Call and await `stop()` from your Stop button or view cleanup. `finished` always settles to a typed exit/failure result, so your UI can report an unexpected server shutdown. A signaled exit is different from an ordinary nonzero exit.

The frontend's dev server and the guest's `npm run dev` are independent. The guest server's port 3000 is a VM port; it does not start a Node server on your computer or a remote backend. Its browser preview depends on the active browser session.

The 120-second wait is a caller-selected deadline, not a performance guarantee. A developer-only shared preview can instead use the explicitly opted-in `isolation: "shared", developmentOnly: true` configuration from the design; production previews need qualified per-session isolation.

## 5. Run your project's commands

For a short command, `exec` captures its output. Arguments are separate strings:

<!-- typecheck: usage/short-command.ts -->
```ts
import type { VM } from "@oxidevm/sdk";

export async function nodeVersion(vm: VM): Promise<string> {
  const result = await vm.exec({ command: "node", args: ["--version"] });
  if (result.exit.kind !== "exited" || result.exit.code !== 0) {
    throw new Error("Node could not report its version");
  }
  return new TextDecoder().decode(result.stdout).trim();
}
```

Expected result: the exact Node version installed in the selected image. `exec` has a bounded output buffer; use `spawn` and stream output for installs, builds, and servers.

For an existing project whose files are already in `/workspace`, reuse `runStreaming` from `src/streams.ts`:

<!-- typecheck: usage/project-commands.ts -->
```ts
import type { ProcessExit, VM } from "@oxidevm/sdk";
import { runStreaming } from "./streams.js";

function requireSuccess(exit: ProcessExit): void {
  if (exit.kind === "signaled") {
    throw new Error(`The command ended with Linux signal ${exit.signalNumber}`);
  }
  if (exit.code !== 0) throw new Error(`The command exited ${exit.code}`);
}

export async function installAndBuild(vm: VM, renderLog: (text: string) => void): Promise<void> {
  requireSuccess(await runStreaming(vm, "npm", ["ci"], renderLog));
  requireSuccess(await runStreaming(vm, "npm", ["run", "build"], renderLog));
}
```

This runs your project's real commands and preserves its scripts and lockfile. The example assumes a matching npm package-lock.json exists. It does not copy a host directory into the VM automatically; your embedding app first supplies the project files using its workspace/upload workflow. Bun and pnpm commands require a custom image with those tools installed.

The writable workspace must belong to uid/gid 1000. The minimal starter and current image builder use that ownership. Package commands also require the selected image to contain the requested runtime and package manager.

Guest internet access is disabled by default. If an install needs uncached downloads, create the VM with a relay connection:

<!-- typecheck: usage/network.ts -->
```ts
import image from "./image.js";
import { createVM, type UserspaceVM, type RelayConnectionOptions } from "@oxidevm/sdk";

export async function openNetworkedProject(connection: RelayConnectionOptions): Promise<UserspaceVM> {
  return createVM({
    mode: "userspace", image,
    workspaceId: "my-project",
    network: { mode: "relay", connection },
  });
}
```

Pass `{ kind: "server", url, sessionUrl }` for your application's authenticated relay. `sessionUrl` is your backend route that authorizes the signed-in user and this workspace; a relative path resolves against your page. Pass `{ kind: "personal", workspaceName: "My project" }` to pair with the relay the user runs on their own computer. `createVM` connects through `vm.network` once the VM is ready and before it resolves. A refused or failed connection disposes the VM and rejects with the relay's typed error, whose `detail.reason` names the failure.

To show the six-digit pairing code while the user approves a personal relay, create the VM with `network: { mode: "local" }`, follow `vm.network.watch(...)` and call `vm.network.connect(...)` yourself. `vm.network.disconnect()` revokes internet access while files, processes and previews keep working.

Your application owns the returned VM and must dispose it. The relay supplies permitted network transport; all package installation and compilation still run in the browser VM. Resolve blocked package build scripts through the explicit guest pnpm approval workflow; do not automatically approve unknown scripts.

## 6. Add an interactive terminal

An interactive shell uses a PTY handle with one `output` stream. Connect that byte stream to your terminal renderer, pass keyboard bytes to `stdin`, and use `interrupt()` for Ctrl+C.

Put this adapter in `src/terminal.ts`. `render` is your terminal renderer's byte-write function:

<!-- typecheck: usage/terminal.ts -->
```ts
import type { VM } from "@oxidevm/sdk";
import type { ProcessCompletion } from "./streams.js";

export async function openTerminal(vm: VM, render: (bytes: Uint8Array) => void) {
  const terminal = await vm.spawn({
    command: "/bin/sh",
    terminal: { columns: 80, rows: 24 },
  });
  const input = terminal.stdin.getWriter();
  const lifetime = Promise.all([
    terminal.exit,
    terminal.output.pipeTo(new WritableStream<Uint8Array>({ write: render })),
  ]);
  const finished: Promise<ProcessCompletion> = lifetime.then(
    ([exit]) => ({ kind: "exited", exit }),
    (error: unknown) => ({ kind: "failed", error }),
  );
  return {
    finished,
    write: (text: string) => input.write(new TextEncoder().encode(text)),
    resize: (columns: number, rows: number) => terminal.resize({ columns, rows }),
    interrupt: () => terminal.interrupt(),
    close: async () => {
      try {
        await terminal.kill("SIGHUP", { scope: "process-group" });
        await finished;
      } finally {
        input.releaseLock();
      }
    },
  };
}
```

Connect your UI as follows:

| UI action | Adapter call |
| --- | --- |
| User types text or presses Enter | Await `write(text)`; Enter sends `"\n"` |
| User presses Ctrl+C | Await `interrupt()` |
| Terminal dimensions change | Await `resize(columns, rows)` |
| Terminal tab closes | Await `close()` |

Serialize keyboard writes and handle their failures. A terminal renderer disappearing does not stop the shell by itself. Two terminals opened on the same VM share its files and process environment; they do not need two `createVM` calls. Closing a terminal keeps the VM available for the rest of your application.

## 7. Use restore points

Both modes expose `start`, `snapshots`, and `suspend` through the same API. Check
`vm.capabilities.snapshots` before offering restore controls. Native Userspace
restore points are experimental in this version.
Restore points retain their runtime mode; loading a point from the other mode
fails with `runtime-mismatch`.

This example captures a file, changes it, and restores the earlier state:

<!-- typecheck: usage/system.ts -->
```ts
import { createVM, type ImageRef } from "@oxidevm/sdk";

export async function restoreEarlierState(image: ImageRef<"system">): Promise<string> {
  const vm = await createVM({ mode: "system", image, workspaceId: "restore-demo" });
  try {
    if (!vm.capabilities.snapshots.available) throw new Error("Restore points are unavailable in this runtime");
    await vm.workspace.writeText("note.txt", "Before the change\n");
    const point = await vm.snapshots.capture({ label: "Before editing" });
    await vm.workspace.writeText("note.txt", "After the change\n");
    await vm.snapshots.restore(point.ref);
    return await vm.workspace.readText("note.txt");
  } finally {
    await vm.dispose();
  }
}
```

Expected result: `Before the change` followed by a newline. A native restore point
captures guest files, memory, processes, and kernel objects, including temporary
files. Restoring defaults to saving a safety point first. Attach the original
processes through `restored.start.terminals`; pre-restore handles are retired.
Explicit restore rolls files back. Automatic resume reconciles newer workspace
files and reports its result in `start.workspaceDetails`.

To explicitly reopen the latest compatible captured session:

<!-- typecheck: usage/resume.ts -->
```ts
import { createVM, type ImageRef, type VM } from "@oxidevm/sdk";

export async function reopenLinux(image: ImageRef<"system">): Promise<VM> {
  const vm = await createVM({
    mode: "system", image,
    workspaceId: "restore-demo",
    restorePoint: "latest",
  });
  if (vm.start.kind === "resumed") {
    console.log(`Resumed ${vm.start.snapshot.label ?? vm.start.snapshot.ref.id}`);
  } else {
    console.log(`Started Linux cold: ${vm.start.reason}`);
  }
  vm.snapshots.autoSave.configure({ enabled: true });
  // Optional discovery runs after the session is ready; offline failure is harmless.
  void vm.checkForUpdate().then(update => {
    if (update !== null) console.log(`Update available: ${update.version}`);
  }).catch(() => {});
  return vm;
}
```

Your caller owns this returned VM. `restorePoint: "latest"` can cold-boot when no usable
point exists and reports that outcome. Omitting `restorePoint` cold-starts with the
current committed files; it does not enable automatic saves. Enable those with
`vm.snapshots.autoSave`. Userspace system-file persistence is separately opt-in
through `rootPersistence: "persistent"`; a native checkpoint also includes
ephemeral files and objects. See the [start-result migration](migration.md#common-restore-point-contract-frame-protocol-5)
for the normalized alpha contract.

## 8. Create and use your own image

The official image is useful for a first experiment. To add your own Linux software, build a managed image locally and pass its generated reference to the SDK.

### Create a Python recipe

From your browser application's root:

```sh
pnpm exec oxidevm image init images/python --mode userspace
```

The command creates an editable Dockerfile and `images/python/oxidevm.image.ts`. Keep the generated pinned base-image inputs. For this Python example, the Dockerfile's relevant instructions are:

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apk add --no-cache python3
```

Set the recipe to:

<!-- typecheck: usage/python-recipe.ts -->
```ts
import type { UserspaceImageRecipe } from "@oxidevm/sdk/image-builder";

export default {
  id: "my-python",
  version: "1.0.0",
  mode: "userspace",
  source: { kind: "dockerfile", context: ".", file: "Dockerfile" },
  resources: { memoryMiB: 512 },
  smokeTest: {
    command: "python3",
    args: ["-c", "print('Python image ready')"],
    expectedExitCode: 0,
    stdoutIncludes: "Python image ready",
  },
} satisfies UserspaceImageRecipe;
```

Docker/BuildKit builds the image on your development machine or CI. A deployed user's browser only needs the finished static assets. The image can contain Python without Node, Bun, or Next.js.

### Sign, build, and test

Generate a signing key once, outside the project:

```sh
pnpm exec oxidevm image keygen --out "$HOME/.config/oxidevm/image-signing.pem"
```

It also creates `image-signing.public.json`. Reuse this key for subsequent builds; do not commit its private PEM or send it to the browser.

Build and test the image in an actual browser:

```sh
pnpm exec oxidevm image build images/python/oxidevm.image.ts --signing-key "$HOME/.config/oxidevm/image-signing.pem"
pnpm exec oxidevm image test images/python/dist --trust "$HOME/.config/oxidevm/image-signing.public.json" --browser chromium
```

The browser smoke test must pass and print `Python image ready`. A successful Docker build alone does not prove the Linux binary runs under the browser engine.

### Stage the image in your application

```sh
pnpm exec oxidevm assets install --image images/python/dist --reference src/generated/python.image.ts
```

This stages the bundle under your application's public assets and creates `src/generated/python.image.ts`. The generated reference pins the manifest digest and your public signing key. You do not write or paste its signature/digest by hand.

### Run your image

Put this in `src/python.ts`:

<!-- typecheck: usage/python.ts -->
```ts
import { createVM } from "@oxidevm/sdk";
import pythonImage from "./generated/python.image.js";

export async function calculateInPython(): Promise<string> {
  const vm = await createVM({ mode: "userspace", image: pythonImage });
  try {
    const result = await vm.exec({ command: "python3", args: ["-c", "print(6 * 7)"] });
    if (result.exit.kind !== "exited" || result.exit.code !== 0) {
      throw new Error("Python did not complete successfully");
    }
    return new TextDecoder().decode(result.stdout).trim();
  } finally {
    await vm.dispose();
  }
}
```

Expected result: `42`.

To iterate, edit the Dockerfile/recipe, then rerun build, browser test, and asset staging. Each generated reference pins the new content. For a different Userspace base image in a persistent workspace, use a new workspace ID; do not assume it silently migrates an existing workspace.

### A custom System image

Use `image init images/my-linux --mode system`. Supply your own kernel and complete disk image. Workspace and process APIs require compatible guest-agent integration in that disk. No managed kernel bootstrap is supplied. Replace the checksum placeholders with the actual file hashes:

<!-- typecheck: usage/system-recipe.ts -->
```ts
import type { SystemImageRecipe } from "@oxidevm/sdk/image-builder";

export default {
  id: "my-linux",
  version: "1.0.0",
  mode: "system",
  source: {
    kind: "boot-files",
    kernel: { path: "kernel.bzImage", sha256: "0".repeat(64) },
    disk: { path: "disk.img", sha256: "0".repeat(64) },
    commandLine: "console=hvc0 root=/dev/vda rw",
  },
  resources: { memoryMiB: 1024, vcpus: 1 },
  smokeTest: {
    command: "/bin/sh",
    args: ["-lc", "printf 'My Linux is ready'"],
    expectedExitCode: 0,
    stdoutIncludes: "My Linux is ready",
  },
} satisfies SystemImageRecipe;
```

Use the same keygen/build/test/stage workflow with that recipe and bundle directory. Its generated reference has the System image type; create its VM with `mode: "system"`. A Userspace reference cannot be passed to System mode.

## 9. Deploy your application

Build your frontend using its normal build command and deploy the complete static output, including the staged `oxidevm` assets. Use HTTPS and the configured browser headers, then check the deployed URL:

```sh
pnpm exec oxidevm doctor https://your-app.example.com/
```

If you distribute a custom image, first supply its actual SBOM, notices, corresponding-source/license evidence, and reproducible inputs. Run both `image build --distribution` and `image test --distribution` with the same recipe, key, trust, and browser options. These checks are required before distribution; signing a development image alone does not satisfy them. Retain exact image artifacts needed by persistent workspaces and restore points.

Use your own hosting and the applicable engine/image license terms. Your application remains a static browser app; users' Linux processes and workspace operations execute in their browsers.

## 10. Common mistakes

| Symptom | Check |
| --- | --- |
| Startup rejects the browser | Run `doctor` against the actual app URL; verify Wasm features, workers, asset MIME, and headers. |
| Files vanish after a normal reopen | Use a stable `workspaceId` on the same origin and await disposal/committed writes. |
| A second VM cannot open the workspace | Keep one active owner for that ID; close the first VM before reopening. |
| A build appears stuck while printing output | Read both stdout and stderr; use streamed `spawn` for verbose or long-running commands. |
| `pnpm install` cannot download packages | Configure permitted guest internet transport; the default network is local. |
| A server runs but has no preview URL | Configure a preview host and expose the port the guest actually listens on. |
| Python is missing from the official image | Build and use your Python image instead of assuming every runtime is installed. |
| A command string with spaces fails | Pass an executable plus `args`; use an explicit guest shell when shell evaluation is intended. |
| An image is rejected after editing output files | Rebuild/sign/test/stage it; do not edit signed artifacts or generated references manually. |

All TypeScript examples are checked against the design document's proposed contracts. Run the shared check from this repository's root:

```sh
node docs/superpowers/specs/2026-10-06-public-sdk-and-cli-design.check.mjs
```

That check validates the example types; actual release support still requires the runtime and browser evidence in the design document.

## Prepared snapshots

Use snapshot init, build, pack, test and inspect to prepare real Linux process state. Recipes run in Node. Preparation and verification run in the browser through public SDK APIs. Snapshot key B independently endorses the unchanged image signed by A. Successful signing does not grant redistribution rights. Bundles remain experimental and need their own distribution evidence. Supply the explicit image bundle and its independently trusted public key.

<!-- typecheck: usage/snapshot-recipe.ts -->
```ts
import type { SnapshotRecipe } from "@oxidevm/sdk/image-builder";
export default {name:"ready",mode:"userspace",image:"/absolute/path/starter-bundle",imageTrust:"/absolute/path/starter.public.json",workload:{module:"./prepare.ts"},verify:{module:"./verify.ts"}} satisfies SnapshotRecipe;
```

<!-- typecheck: usage/snapshot-prepare.ts -->
```ts
import type { PrepareSnapshot, SnapshotProcess } from "@oxidevm/sdk";
async function send(process: SnapshotProcess, input: string): Promise<void> {
  const writer = process.stdin.getWriter();
  try { await writer.write(new TextEncoder().encode(input)); }
  finally { writer.releaseLock(); }
}

const prepare: PrepareSnapshot = async ({ vm, start }) => {
  await vm.workspace.writeText("/welcome.txt", "Prepared workspace\n");
  const token = crypto.randomUUID();
  const shell = await start("shell", { command: "/bin/sh", args: ["-i"],
    cwd: "/workspace", terminal: { columns: 80, rows: 24 } });
  await send(shell, "KEEP='" + token + "'; printf 'prepared:%s:%s\\n' \"$KEEP\" \"$$\"\n");
  await shell.waitForOutput("prepared:" + token + ":" + String(shell.pid));
  return { token, pid: shell.pid };
};
export default prepare;
```

<!-- typecheck: usage/snapshot-verify.ts -->
```ts
import type { VerifySnapshot, SnapshotProcess } from "@oxidevm/sdk";
async function send(process: SnapshotProcess, input: string): Promise<void> {
  const writer = process.stdin.getWriter();
  try { await writer.write(new TextEncoder().encode(input)); }
  finally { writer.releaseLock(); }
}

function proof(value: unknown): { token: string; pid: number } {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 2
    || !("token" in value) || typeof value.token !== "string"
    || !("pid" in value) || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Invalid captured proof");
  return { token: value.token, pid: value.pid };
}
const verify: VerifySnapshot = async ({ vm, data, attach }) => {
  const expected = proof(data);
  if (await vm.workspace.readText("/welcome.txt") !== "Prepared workspace\n") throw new Error("Prepared file was not restored");
  const shell = await attach("shell");
  if (shell.pid !== expected.pid) throw new Error("Original shell PID changed");
  await send(shell, "printf 'restored:%s:%s\\n' \"$KEEP\" \"$$\"\n");
  await shell.waitForOutput("restored:" + expected.token + ":" + String(expected.pid));
};
export default verify;
```

The following checked embedding function accepts the generated default options module. Import it from the reference written by assets install --snapshot, then pass it to openPrepared. Every workspace ID keeps its own files and saves. New references initialize only empty workspaces or the same interrupted source; existing user state takes precedence. Explicit resume none bypasses the prepared start.

<!-- typecheck: usage/snapshot-use.ts -->
```ts
import { createVM } from "@oxidevm/sdk";
import type { UserspaceOptions } from "@oxidevm/sdk";
export async function openPrepared(prepared: UserspaceOptions, workspaceId: string, previewOrigin: string) {
  const vm = await createVM({...prepared,workspaceId,restorePoint:"latest",preview:{origin:previewOrigin,isolation:"per-session"}});
  await vm.snapshots.autoSave.configure({enabled:true});
  const terminals = vm.start.kind === "resumed" ? vm.start.terminals : [];
  return {vm,terminals,suspend:() => vm.suspend({label:"User handoff"})};
}
```

Build/pack require a snapshot signing key. Test/install require its external public trust anchor. Custom images require separately selected image trust. The CLI reports one final JSON envelope on stdout, safe monotonic progress on stderr, and exit 3 for executed verification failures. Inspect executes no author code and does not demonstrate runtime restoration. Capture and fresh restoration can require several GiB of browser and host storage; capacity failures remain typed failures.
