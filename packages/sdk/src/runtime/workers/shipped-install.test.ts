import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagedImageSnapshot } from "../managed-image.js";
import { ManagedBases } from "./managed-base.js";
import { liveGenerationFor } from "./managed-disk-head.js";
import { cachedTestImage, openTestDisk, type TestImage } from "./managed-image.test-support.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { concat, testSigner } from "./snapshot-archive/backup.test-support.js";
import { gzip } from "./snapshot-archive/gzip.js";
import { publishShipped } from "./snapshot-archive/shipped-publish.js";
import { writeBackup } from "./snapshot-archive/writer.js";
import { sha256Hex } from "./snapshot-content.js";
import type { SnapshotManifest } from "./snapshot-manifest.js";
import { SnapshotStore } from "./snapshot-store.js";
import { fetchBounded, installShipped, type ShippedInstallRun } from "./shipped-install.js";
import {decodeShippedInstallIdentity} from "../protocol/shipped-source.js";

const MIB = 1024 * 1024;
const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const CLOCK = { now: () => NOW, startOfDay: (unixMs: number) => unixMs - (unixMs % 86_400_000) };
const KERNEL = new Uint8Array([0x4b, 0x45, 0x52]);
const KEY_ID = "boundary-development-2026";
const PROFILE = new URL("https://ide.example.test/profiles/test-image/2026.10.02/manifest.json");

interface Browser {
  readonly workspace: MemoryDirectory;
  readonly store: SnapshotStore;
  readonly image: TestImage;
}

async function browser(): Promise<Browser & { readonly disk: Awaited<ReturnType<typeof openTestDisk>> }> {
  const workspace = new MemoryDirectory("workspace");
  const images = new MemoryDirectory("managed-images");
  const bases = new ManagedBases();
  const image = await cachedTestImage(images, [1, 2, 0, 0]);
  const store = await SnapshotStore.open(workspace, {
    images,
    bases,
    workspaceId: "test",
    clock: CLOCK,
    machine: { memoryMiB: 16, vcpus: 1 },
    image: () => ({ id: image.ref.id, version: image.ref.version }),
  });
  const disks = workspace.directory("managed-disks", true);
  const disk = await openTestDisk(disks, images, bases, image, await liveGenerationFor(disks, image.ref));
  await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, disk);
  return { workspace, store, image, disk };
}

/** A example captured at build time and published beside its profile, signed by the build key. */
interface Publication {
  readonly listing: ManagedImageSnapshot;
  readonly files: Map<string, Uint8Array<ArrayBuffer>>;
  readonly snapshot: SnapshotManifest;
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly image: TestImage;
}

async function publication(): Promise<Publication> {
  const author = await browser();
  author.disk.write(2 * MIB, new Uint8Array(MIB).fill(9));
  await author.store.openCapture({
    type: "open-capture",
    snapshot: { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" },
    kind: "named",
    label: "Boundary · container ready",
    memoryBytes: 16 * MIB,
    vcpus: 1,
  }, author.disk);
  await author.store.sealCapture({
    type: "seal-capture",
    capturedAtUnixMs: Date.parse("2026-10-02T10:00:02.000Z"),
    machineRecord: new Uint8Array([0x4f, 0x58, 0x4d, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]),
    ramChunks: [0, 3],
    disk: { kind: "managed", bytes: author.disk.length, chunks: [] },
  }, author.disk);
  await author.store.putCaptureChunk("ram", 0, new Uint8Array(MIB).fill(5));
  await author.store.putCaptureChunk("ram", 3, new Uint8Array(MIB).fill(6));
  const ref = await author.store.commitCapture();
  const source = await author.store.openExport(ref);
  const backup: Uint8Array[] = [];
  await writeBackup(source.manifest, (object) => source.read(object), (bytes) => {
    backup.push(bytes.slice());
    return Promise.resolve();
  });
  source.release();
  const signer = await testSigner(KEY_ID);
  const published = await publishShipped(new Blob([concat(backup)]).stream(), {
    name: "container-ready",
    label: "Boundary · container ready",
    image: author.image.ref,
    signer,
    nowUnixMs: NOW,
    maxDownloadBytes: 64 * MIB,
  });
  const folder = new URL("./snapshots/container-ready/", PROFILE);
  const files = new Map<string, Uint8Array<ArrayBuffer>>([
    [new URL("manifest.json", folder).href, published.manifest],
    ...published.chunks.map(({ name, bytes }): [string, Uint8Array<ArrayBuffer>] => [new URL(name, folder).href, bytes]),
  ]);
  return {
    listing: {
      name: "container-ready",
      manifest: { url: new URL("manifest.json", folder), bytes: published.manifest.byteLength, sha256: await sha256Hex(published.manifest) },
      bytes: published.chunkBytes,
    },
    files,
    snapshot: { ...source.manifest, kind: "shipped", label: "Boundary · container ready" },
    publicKey: signer.publicKey,
    image: author.image,
  };
}

/** A server for `files`: it logs each fetch, counts how many run at once, and can fail some. */
function server(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, fails: (url: string, attempt: number) => boolean = () => false) {
  const fetched: string[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  const fetchBytes: ShippedInstallRun["fetchBytes"] = async (url, maxBytes) => {
    fetched.push(url.href);
    const attempt = (attempts.get(url.href) ?? 0) + 1;
    attempts.set(url.href, attempt);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      // A download takes a few event-loop turns, so concurrent ones overlap as on a network.
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      const body = files.get(url.href);
      if (body === undefined || fails(url.href, attempt)) throw new Error(`404 ${url.href}`);
      if (body.byteLength > maxBytes) throw new Error("too large");
      return body.slice();
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchBytes, fetched, peak: () => peak };
}

function run(fetchBytes: ShippedInstallRun["fetchBytes"], overrides: Partial<ShippedInstallRun> = {}): ShippedInstallRun {
  let tail = Promise.resolve();
  return {
    enqueue: <T>(turn: () => Promise<T>): Promise<T> => {
      const work = tail.then(turn);
      tail = work.then(() => undefined, () => undefined);
      return work;
    },
    signal: new AbortController().signal,
    now: () => NOW,
    fetchBytes,
    backoff: () => Promise.resolve(),
    ...overrides,
  };
}

function trust(published: Publication) {
  return { trusted: { keyId: KEY_ID, publicKey: published.publicKey }, image: published.image.ref };
}

async function refusal(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

function objectNames(target: Browser): string[] {
  return target.workspace.directory("snapshots-v2", true).directory("objects", true).names();
}

describe("shipped restore point downloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads a body up to its limit and stops past it", async () => {
    const body = (bytes: number) => new Response(new Uint8Array(bytes).fill(7), { status: 200 });
    vi.stubGlobal("fetch", (input: unknown) => Promise.resolve(String(input).endsWith("/big") ? body(2049) : String(input).endsWith("/gone") ? new Response("not found", { status: 404 }) : body(2048)));
    const signal = new AbortController().signal;

    await expect(fetchBounded(new URL("https://ide.example.test/small"), 2048, signal)).resolves.toHaveLength(2048);
    await expect(fetchBounded(new URL("https://ide.example.test/big"), 2048, signal)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(fetchBounded(new URL("https://ide.example.test/gone"), 2048, signal)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("shipped restore point install", () => {
  it("new_ref_preserves_source_id_without_overwriting_collision", async () => {
    const published = await publication();
    const target = await browser();
    const source = decodeShippedInstallIdentity({mode:"system",snapshotManifestSHA256:published.listing.manifest.sha256,imageManifestSHA256:"ab".repeat(32)});
    const first = await installShipped(target.store,published.listing,trust(published),run(server(published.files).fetchBytes),source);
    expect(first.ref.id).toBe(published.snapshot.id);
    const repeated = await installShipped(target.store,published.listing,trust(published),run(server(published.files).fetchBytes),source);
    expect(repeated.ref).toEqual(first.ref);
    const different = {...source,snapshotManifestSHA256:decodeShippedInstallIdentity({mode:"system",snapshotManifestSHA256:"cd".repeat(32),imageManifestSHA256:"ab".repeat(32)}).snapshotManifestSHA256};
    await expect(installShipped(target.store,published.listing,trust(published),run(server(published.files).fetchBytes),different)).rejects.toMatchObject({code:"STORAGE_ERROR"});
    expect((await target.store.list()).filter(info=>info.kind === "shipped")).toHaveLength(1);
  });
  it("installs a signed shipped restore point, four chunks at a time, once", async () => {
    const published = await publication();
    const target = await browser();
    const served = server(published.files);

    const installed = await installShipped(target.store, published.listing, trust(published), run(served.fetchBytes));
    const again = await installShipped(target.store, published.listing, trust(published), run(served.fetchBytes));

    expect(installed).toMatchObject({ kind: "shipped", label: "Boundary · container ready", resumable: true });
    expect(again.ref).toEqual(installed.ref);
    expect(served.peak()).toBeGreaterThan(1);
    expect(served.peak()).toBeLessThanOrEqual(4);
    const prepared = await target.store.prepareRestore(installed.ref, true, target.disk);
    expect(prepared.ramChunks).toEqual([0, 3]);
    // A first visit: the pristine disk holds nothing the restore point lacks.
    expect(prepared.newerFiles).toBe(false);
    await target.store.abort();
  });

  it("never commits a tampered chunk, and stores nothing it could not verify", async () => {
    const published = await publication();
    const target = await browser();
    const tampered = new Map(published.files);
    if (published.snapshot.schema !== 2) throw new Error("expected system fixture");
    const machine = published.snapshot.machine;
    // The machine record: other content of the same size, so only its hash can tell.
    const chunkUrl = [...tampered.keys()].find((url) => url.endsWith(`/chunks/${machine.record.sha256}.gz`));
    if (chunkUrl === undefined) throw new Error("no machine record chunk");
    tampered.set(chunkUrl, await gzip(new Uint8Array(machine.record.bytes).fill(0xee)));

    const error = await refusal(installShipped(target.store, published.listing, trust(published), run(server(tampered).fetchBytes)));

    expect(error).toMatchObject({ detail: { reason: "shipped-damaged" } });
    expect(await target.store.list()).toEqual([]);
    expect(objectNames(target)).not.toContain(await sha256Hex(new Uint8Array(machine.record.bytes).fill(0xee)));
  });

  it("lets collection reclaim what a failed install stored", async () => {
    const published = await publication();
    const target = await browser();
    const before = objectNames(target);
    const lost = [...published.files.keys()].filter((url) => url.includes("/chunks/")).at(-1);

    expect(await refusal(installShipped(target.store, published.listing, trust(published), run(server(published.files, (url) => url === lost).fetchBytes)))).toBeDefined();
    expect(objectNames(target).length).toBeGreaterThan(before.length);
    await target.store.maintain();

    expect(objectNames(target)).toEqual(before);
    expect(target.workspace.directory("snapshots-v2", true).directory("intents", true).names()).toEqual([]);
  });

  it("retries a failed chunk, and a later install fetches only what is missing", async () => {
    const published = await publication();
    const target = await browser();
    const chunks = [...published.files.keys()].filter((url) => url.includes("/chunks/"));
    const lost = chunks.at(-1);
    if (lost === undefined) throw new Error("no chunks");
    const flaky = server(published.files, (url, attempt) => url === chunks[0] && attempt === 1);
    const broken = server(published.files, (url) => url === lost);

    await expect(installShipped(target.store, published.listing, trust(published), run(flaky.fetchBytes))).resolves.toMatchObject({ kind: "shipped" });
    expect(flaky.fetched.filter((url) => url === chunks[0])).toHaveLength(2);

    const second = await browser();
    expect(await refusal(installShipped(second.store, published.listing, trust(published), run(broken.fetchBytes))))
      .toMatchObject({ detail: { reason: "shipped-unavailable" } });
    const resumed = server(published.files);
    await installShipped(second.store, published.listing, trust(published), run(resumed.fetchBytes));
    expect(resumed.fetched.filter((url) => url.includes("/chunks/"))).toEqual([lost]);
  });

  it("refuses a manifest that is not the one the profile pins, before fetching any chunk", async () => {
    const published = await publication();
    const target = await browser();
    const served = server(published.files);
    const listing = { ...published.listing, manifest: { ...published.listing.manifest, sha256: "0".repeat(64) } };

    expect(await refusal(installShipped(target.store, listing, trust(published), run(served.fetchBytes)))).toMatchObject({ detail: { reason: "shipped-damaged" } });
    expect(served.fetched.filter((url) => url.includes("/chunks/"))).toEqual([]);
  });
});
