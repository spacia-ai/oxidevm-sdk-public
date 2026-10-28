# Image authoring

Build on Node 24 or later; image programs execute inside the browser VM. Use a
dedicated directory and `image.lock.json` for each recipe, with one reusable
author key kept outside the repository.

```sh
pnpm exec oxidevm image init images/python --mode userspace
pnpm exec oxidevm image keygen --out /private/path/author.pem
pnpm exec oxidevm image build images/python/oxidevm.image.ts --signing-key /private/path/author.pem
pnpm exec oxidevm image inspect images/python/dist --trust /private/path/author.public.json
pnpm exec oxidevm image test images/python/dist --trust /private/path/author.public.json --browser chromium
pnpm exec oxidevm assets install --image images/python/dist --reference src/generated/python.image.ts
```

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
