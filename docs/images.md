# Image authoring

## Start with the installed release

The generated data starter uses a prebuilt signed Linux Python + pandas image.
Normal app development needs no Docker, image recipe or local engine.
Generated projects do not contain an `image/` directory. Their README links to
`examples/starter/image/` and this guide in the exact SDK source release.
`LICENSES.md` links to the selected image's independently versioned source and
license release. SDK and image versions are different identities.

Read those pinned links before modifying the image. Do not use `main`,
`releases/latest`, or a recipe from a newer SDK as a substitute. For an older
starter whose README has no pinned links, run this in the project directory:

```sh
SDK_VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('node_modules/@oxidevm/sdk/package.json', 'utf8')).version")"
printf 'Recipe: https://github.com/spacia-ai/oxidevm-sdk-public/tree/v%s/examples/starter/image\n' "$SDK_VERSION"
printf 'Guide: https://github.com/spacia-ai/oxidevm-sdk-public/blob/v%s/docs/images.md\n' "$SDK_VERSION"
```

Unpublished candidates can reference a tag that does not exist yet. Use their
reviewed source checkout until publication. Do not silently select another release.

The data image's real recipe contains `Dockerfile`, `oxidevm.image.ts`,
`inputs.lock.json`, `python-inputs.lock.json`, `source-lock.json`, preparation
and compliance scripts, utility build scripts and component/license inventories.
It does not use a generic `requirements.lock`. `image init` writes an initial
`image.lock.json`, which the builder updates. It does not replace source locks.

The maintainer recipe also requires a separately supplied, exact Python base
rootfs, signed bundle and independent author trust. See its README for the
`OXIDEVM_PANDAS_BASE_ROOTFS`, `OXIDEVM_PANDAS_BASE_BUNDLE` and
`OXIDEVM_PANDAS_BASE_TRUST` inputs and hash checks. The source/license archive
is not that rootfs, an OCI base image, or a runnable bundle. Copying only the
Dockerfile cannot reproduce the image. If those inputs are unavailable, create
an author-owned image with the workflow below instead of inventing their paths.

## Build an author-owned image

Run these commands in your application's directory. Use its installed CLI so
SDK and CLI versions match. Node.js 24 or newer, Docker with Buildx/BuildKit,
and a working `linux/amd64` builder are required. Native compilation can need
more CPU and memory than running the finished image. The browser runs the
finished Linux programs, not Docker.

1. Create a separate recipe directory:

   ```sh
   npm exec -- oxidevm image init images/my-linux --mode userspace
   ```

   This creates `Dockerfile`, `.dockerignore`, `.gitignore`, `oxidevm.image.ts`,
   an initial `image.lock.json` and a README.
   It is a minimal Linux scaffold, not a copy of the Python + pandas image.
   Edit its Dockerfile to supply the actual Linux x86-64 programs, loader,
   shared libraries, data and certificates your app needs. Keep `/workspace`
   writable by uid/gid 1000. Host npm dependencies do not install guest programs.

2. Pin the base digest and every package/source input. Record hashes, build
   flags, licenses and notices. Keep compilers and caches in build stages.
   Copy only the runtime closure into the final image. An `apk add` or `pip
   install` against a moving repository is not a reproducible input lock.
   The default NumPy build disables external BLAS/LAPACK and Fortran runtimes;
   replacing it with an arbitrary wheel changes both compatibility and licensing.

3. Edit `oxidevm.image.ts`. For these examples, set `id: "my-linux"` and
   `version: "1.0.0"`. Use your own image identity for real distribution. Set a fixed `sourceDateEpoch` and appropriate memory. Keep `mode: "userspace"`.
   Set `smokeTest.command`, `args`, `expectedExitCode` and `stdoutIncludes` to
   exercise the new program and its native dependencies. The generated shell
   smoke test alone does not test an added package. The Node-only recipe API is
   `@oxidevm/sdk/image-builder`; browser application APIs stay in `@oxidevm/sdk`.

   The scaffold lock identifies `custom-linux`. After changing that initial
   identity, remove only this new scaffold lock before the first build:

   ```sh
   rm images/my-linux/image.lock.json
   ```

   The builder writes a new lock for your recipe. For later versions, retain
   the old lock and bundle separately before creating the new version's lock.

4. Create one author key outside Git, the Docker context and output archives:

   ```sh
   mkdir -p "$HOME/.config/oxidevm"
   npm exec -- oxidevm image keygen --out "$HOME/.config/oxidevm/image-author.pem"
   ```

   Retain the companion `image-author.public.json` independently. Back up the
   private key securely. Never copy a new trust key from the image download
   origin to bypass verification. Saved workspaces bind image and signing identity.

5. Build and inspect a local development candidate:

   ```sh
   npm exec -- oxidevm image build images/my-linux/oxidevm.image.ts --signing-key "$HOME/.config/oxidevm/image-author.pem"
   npm exec -- oxidevm image inspect images/my-linux/dist --trust "$HOME/.config/oxidevm/image-author.public.json"
   ```

   The output directory contains the signed manifest, blobs/packs, generated
   `my-linux.image.ts`, `image.lock.json` and evidence. Keep these outside Git.
   A development signature does not authorize distributing the candidate.

6. Run its smoke test in Chromium:

   ```sh
   npm exec --package playwright@1.61.1 -- playwright install chromium
   npm exec -- oxidevm image test images/my-linux/dist --trust "$HOME/.config/oxidevm/image-author.public.json" --browser chromium --engine-dir /absolute/path/to/matching-engine-release
   ```

   The current image-test harness uses a local, matching pinned engine and its
   compliance materials. Obtain these under the engine's applicable terms before
   using this explicit test path. Building an image does not require an engine.
   This test path does not change the application's hosted runtime configuration.
   If the engine is unavailable, report the automated browser test as blocked;
   do not claim a successful Docker build proves OxideVM compatibility.

For Bun-managed applications, use `bunx --no-install oxidevm` instead of
`npm exec -- oxidevm`. Keep using the CLI installed with the project.
Add `--use-bun` to `init` when Bun should install and start the new app.

## Select the image without installing an engine

For a fresh development app, the CLI supports an explicit local image:

```sh
npm exec -- oxidevm init custom-app --image images/my-linux/dist --image-trust "$HOME/.config/oxidevm/image-author.public.json" --start
```

This stages the supplied image and keeps `runtime: { hosting: "frame" }`.
It does not install engine binaries. The data starter still expects Python,
NumPy and pandas, so a shell-only image requires a different application workload.
A minimal image is useful for its own smoke test, not as a drop-in data image.

For an existing generated app, first export important workspace data and retain
its old image references. Stop the VM before changing its image. Use the public
`installProjectAssets` API with `hosting: "frame"` for local development staging:

<!-- typecheck: images/stage.ts -->
```ts
import { readImageTrust, installProjectAssets } from "@oxidevm/sdk/image-builder";

await installProjectAssets(process.cwd(), {
  mode: "userspace",
  publicDir: ".oxidevm/assets",
  assetBaseUrl: "/oxidevm/",
}, {
  hosting: "frame",
  imageDir: "images/my-linux/dist",
  trust: await readImageTrust("/absolute/path/to/image-author.public.json"),
  referencePath: "src/custom.image.ts",
});
```

Run this as a Node-only script from the project root. Use a new generated
reference path. Before running it, move the existing `oxidevm.lock.json` to a
backup outside the app and remove the old `image` from `oxidevm.config.ts`.
The installer refuses a lock or explicit image that identifies another bundle.
Keep the same `mode`, `publicDir` and `assetBaseUrl` as above. Import the new
reference from the config after staging. Change the development image import
in `src/main.ts` to `./custom.image.js`. Keep `src/runtime.ts` on frame hosting.
Do not use the bare `assets install` command for this hosted-only path: it
currently selects local engine installation.

Vite serves `.oxidevm/assets` only in development. These files are not copied
into the production build. Test the actual application: interpreter/package
imports, CSV upload, repeated execution, terminal, restart and persistence.
Test tampered-image rejection. Existing stored workspaces do not migrate merely
because a source import changes. Follow the explicit image-update procedure in
[the usage guide](usage.md), or test in a separate disposable workspace.

## Distribute and select a production image

Before sharing any candidate, provide its actual inventory, complete notices,
license texts, corresponding sources, independent rebuild evidence and required
reviews. Select a new immutable image version. Run `image build --distribution`
and `image test --distribution` with the same recipe, author key, trust and
engine pin. Missing evidence must block release. See the validation API below.
A signed development bundle or passing smoke test cannot replace these checks.

After approval, host the entire qualified bundle at an immutable HTTPS location.
Use `image build --base-url https://your-image-host.example/images/my-linux/1.0.0/`
to bind its location before qualification. The builder adds the manifest digest
to that base path; use its returned manifest URL, not a guessed path.
Publish corresponding sources and license materials before dependent binaries.
Serve all required sidecars, evidence, blobs and packs. Allow CORS reads from
the hosted runtime origin and the app, with suitable cross-origin resource
headers. Keep old image URLs reachable for saved workspaces.

Use the builder-generated `my-linux.image.ts` for both `src/image.ts` and
`src/production-image.ts` when both environments should select that image.
Set the matching `image` in `oxidevm.config.ts`. Regenerate the project lock
explicitly from that configuration; preserve the old lock for rollback. Use
`createProjectLock` from `@oxidevm/sdk/image-builder`, not a manual JSON edit.
Do not leave production pointing to the original pandas image accidentally.
Keep the independently verified author key and manifest hash in the reference.
The app continues to use the hosted runtime in development and production.
Licensed engine self-hosting is a separate deployment choice.

| Source | Userspace | System | Input ownership |
| --- | --- | --- | --- |
| `dockerfile` | Supported | Supported | Genuine Buildx/BuildKit, `linux/amd64`, actual solve provenance |
| `oci` | Supported | Supported | Docker export; distribution requires an immutable digest |
| `directory` | Supported | Supported | Author-owned rootfs, modes, ownership and links |
| `archive` | Supported | Supported | Exact SHA-256-pinned archive and bounded extraction |
| `boot-files` | Rejected | Supported | Pinned kernel, optional initrd and disk |

These are implemented adapters, not a claim that every pair is browser-qualified.
System rootfs recipes also select a kernel and disk size. Boot-files supplies
its disk directly. Arbitrary images need no Node/Bun/Next metadata; the Python-only
sample proves that boundary. Explicit resources are signed, while caller process
limits take precedence and native process admission counts descendants.

The builder records an epoch before external tools run, signs canonical
manifests and publishes a complete output atomically. Failure preserves the
previous bundle. Genuine BuildKit facts include tool identities, actual resolved
base digests, Dockerfile/context content, arguments and target. Rebuilds apply
the resolved source policy; content-addressed context staging prevents local
cache reuse of equal-size changed files at a fixed epoch.

New Userspace images use signed rootfs schema 8. Each inode records exact access
and modification nanoseconds, normalized to `sourceDateEpoch` just like the
builder's ext4 output. Hardlinks must agree on these values. The runtime sends
them through OXRF v8, so a framework's shipped cache sees the same file times as
its source build. Schemas 1–7 remain readable with their original metadata
semantics. Changes made inside a guest retain their actual nanoseconds through
workspace capture and restore; the Linux kernel owns change times.

`dockerfile` and `oci` sources reach the builder through `docker export` of a
container, whose init layer covers some paths whatever the image holds. The builder
puts the image's own entries back there from its layers (`docker image save`):
`/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf` and `/etc/mtab` are the image's,
so a Dockerfile `COPY` of them is kept, and `/.dockerenv`, `/dev/console`,
`/dev/pts`, `/dev/shm`, `/proc` and `/sys` exist only when the image has them.
Userspace VMs name themselves `oxidevm` and serve no DNS, so a program that looks
up its own host name (Python's `HTTPServer` does when it starts) waits for the
resolver's timeout unless the image's `/etc/hosts` names `oxidevm`.

Userspace processes run as uid/gid 1000 unless the VM asks for root, so the
builder records `/workspace` and every entry below it as owned by `1000:1000`,
whatever the source recorded. Every other entry keeps its source owner. A
Userspace recipe can name another workspace owner with
`workspace: { ownership: { uid, gid } }`, with IDs from 0 to 4294967294; any
other value is an `INVALID_ARGUMENT`. System recipes reject the option
because their ext4 disk keeps the source's owners. The runtime mounts
`/workspace` separately, so the builder also rejects a hardlink between it and
the rest of the rootfs. Images built before this rule keep the owners they
signed; rebuild one with a root-owned workspace so the default user can write
to it.

Distribution requires actual SPDX inventory, notices, license-policy review,
corresponding sources and independent reproducible builds. Scanner output is
reconciled with filesystem ownership. Declared licenses are not approved
conclusions. Review remote and package-manager inputs before considering a
Dockerfile reproducibly locked. Keep credentials out of arguments, contexts,
exported layers and reports; no public recipe secret-value field exists.

The generated reference pins the manifest digest and external Ed25519 key.
Never replace that key using a file fetched from the image origin. Unsigned
inspection reports `unverified`; explicit trust authenticates the signature and
full referenced closure. Staging excludes unrelated author files. URL relocation
preserves identities and engine compatibility.

Userspace schema 8 and System schema 9 are used by this candidate. Tampered
bytes and incompatible resources/protocols reject before readiness. A development
bundle explicitly reports missing evidence. Its signature or smoke test does
not make it distributable. Kernels and guest packages retain their real licenses
and corresponding-source obligations. See [usage](usage.md) for recipes and the
[development guide](development.md) for verification requirements.

Schema 8 adds authenticated gzip packs of four MiB decoded data, in deterministic
blob digest order. Large files span chunks; loose URLs still support demand reads.
Saves acquire the complete image through at most two pack downloads at once and
store decoded packs directly, with bounded buffers. A committed native checkpoint
remains complete offline. The manifest digest and signature bind both the original
file identities and the pack layout. Existing pinned images are never upgraded
automatically.

After validating all original files in a signed packed layout, storage records
that proof in a private version-3 image pin. On-demand sessions retain full image
verification. Installed `before-ready` sessions reuse complete pins and check
local availability without scanning every image body on each reload or save.
Demand reads authenticate each complete logical file before guest delivery,
including files addressed through untrusted legacy layouts. First installation,
import and explicit repair still verify the complete dependency closure. Native
checkpoint objects retain fresh transaction verification. Checkpoint and backup
schemas are unchanged.

Deploy the complete builder bundle, including `packs/`, loose blobs, evidence,
manifest and lock, at the new manifest URL returned by `buildImage`. Keep older
versioned bundles reachable. Publish the matching SDK runtime-host assets together;
frame protocol 9, worker protocol 71 and snapshot channel 13 reject incompatible clients before restore.
A signature does not replace the guest-artifact publication approval.

For an existing whole-manifest signed Userspace bundle, run
`oxidevm image pack <bundle> --trust <trust-file>`. This writes deterministic packs
and `transport/<original-manifest-sha256>/packs-v1.json` beside the unchanged
manifest and lock. Publish those additions at the original image directory before
enabling the new client. Keep the loose URLs available for old readers. The optional
sidecar can fall back to loose acquisition only on HTTP 404; invalid metadata,
unavailable packs and hash failures stop installation explicitly.

The sidecar is transport metadata, not new signing authority. Complete signed blob
coverage, image-directory URL bounds, decoded extents, gzip output bounds and both
pack hashes are validated. Every original signed file identity is checked before
the derived local layout commits. Legacy layouts remain untrusted and retain
logical-file verification against the original manifest before file delivery.

`imagePreparation: "before-ready"` installs the actual cold, retained or shipped-start
image before guest execution. `"on-demand"` remains the SDK default. Installations
are keyed by manifest digest and shared within the runtime origin's browser storage
partition. Durable journals retain verified packs across interruption; retries
recheck and acquire only missing or damaged data. Required packed copies remain
pinned even when no loose alternative exists. Reset retains immutable image data;
explicit local-data erasure removes it. `prepareImage()` repairs the selected image
without restarting the guest. Imports and explicit updates can install new assets.

Cached starts authenticate the selected manifest and inspect local file sizes.
Same-size corruption in an unused file is detected when that file is consumed,
or by explicit repair. System authenticates each base chunk on its first read
through an exclusive storage handle. It reuses that proof until repair or close.
Snapshot memory, process state and writable-file validation are unchanged.

## Validate a distribution bundle

The Node-only image builder can authenticate a finished bundle and validate
its complete distribution evidence before staging it:

```ts
import { readFile } from "node:fs/promises";
import { readImageTrust, validateImageDistribution } from "@oxidevm/sdk/image-builder";

const components: unknown = JSON.parse(await readFile("components.json", "utf8"));
const verified = await validateImageDistribution("./image/dist", {
  trust: await readImageTrust("./author.public.json"),
  components,
});
console.log(verified.inspection.manifestSHA256);
```

Supply author trust independently. Component pins use `{name, version, license}`
records from the reviewed recipe. The validator checks the signed artifact set,
reproduction evidence, file inventory, notices, source materials, and required
relink files. Bun inventories must include WebKit and tinycc under their own
LGPL terms. A Bun MIT label or source archive alone cannot satisfy this check.
Technical validation does not supply human legal review or publication approval.
