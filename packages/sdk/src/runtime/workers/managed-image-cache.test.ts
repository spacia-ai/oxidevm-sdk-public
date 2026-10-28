import { afterEach, describe, expect, it, vi } from "vitest";

import { ManagedBases } from "./managed-base.js";
import { liveGenerationFor, managedImageStem, writeDiskHead, writeGenerationRecord } from "./managed-disk-head.js";
import { prepareManagedDisk, prepareCurrentManagedImage } from "./managed-image-cache.js";
import { cachedTestImage, openTestDisk, type TestImage } from "./managed-image.test-support.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { readOpfsFile } from "./snapshot-objects.js";
import { record } from "../decode.js";
import { sha256Hex } from "./snapshot-content.js";
import { checkManagedImageUpdate } from "./managed-image-update.js";

const MANIFEST_URL = "https://example.test/profiles/test-image/manifest.json";
const KERNEL = new Uint8Array([0x4b, 0x45, 0x52]);

interface Storage {
  readonly oxidevm: MemoryDirectory;
  readonly images: MemoryDirectory;
  readonly workspace: MemoryDirectory;
  readonly bases: ManagedBases;
}

function storage(): Storage {
  const oxidevm = new MemoryDirectory("oxidevm");
  return {
    oxidevm,
    images: oxidevm.directory("managed-images", true),
    workspace: new MemoryDirectory("workspace"),
    bases: new ManagedBases(),
  };
}

function prepare(context: Storage, release?: () => void, boot: "live" | "pre-resume" | "update-image" = "live") {
  return prepareManagedDisk(
    { oxidevm: context.oxidevm, workspace: context.workspace, workspaceId: "test", bases: context.bases },
    MANIFEST_URL,
    undefined,
    boot,
    release ?? (() => undefined),
  );
}

/** Serves `text` as the profile manifest and nothing else. */
function serveManifest(text: string): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return url === MANIFEST_URL ? Promise.resolve(new Response(text)) : Promise.reject(new TypeError("Failed to fetch"));
  });
}

/** The manifest text the pinned record of `image` keeps. */
async function pinnedManifestText(context: Storage, image: TestImage): Promise<string> {
  const bytes = await readOpfsFile(context.images, `${managedImageStem(image.ref)}.image.json`, 4 * 1024 * 1024);
  const record: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof record !== "object" || record === null || !("manifest" in record) || typeof record.manifest !== "string") {
    throw new Error("the pinned record has no manifest");
  }
  return record.manifest;
}

describe("managed image preparation", () => {
  it("checks a requested system update explicitly without replacing its disk", async () => {
    const context = storage(), image = await cachedTestImage(context.images, [1]);
    const text = await pinnedManifestText(context, image);
    serveManifest(text);
    expect(await checkManagedImageUpdate(MANIFEST_URL, image.ref, {})).toBeNull();
    const updated = { ...record(JSON.parse(text) as unknown, "manifest"), version: "new" };
    serveManifest(JSON.stringify(updated));
    expect(await checkManagedImageUpdate(MANIFEST_URL, image.ref, {})).toEqual({ id: image.ref.id, version: "new" });
    await expect(checkManagedImageUpdate(MANIFEST_URL, image.ref, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
    expect(context.workspace.find("managed-disks/head.json")).toBeUndefined();
  });
  it("cancels cached before-ready verification without selecting a generation or releasing the running disk", async () => {
    const context = storage(), image = await cachedTestImage(context.images, [1]), lifetime = new AbortController();
    const kernel = context.images.file(`${managedImageStem(image.ref)}.kernel`, false), get = kernel.getFile.bind(kernel);
    vi.spyOn(kernel, "getFile").mockImplementation(async () => { const file = await get(); lifetime.abort(); return file; });
    const release = vi.fn();
    await expect(prepareManagedDisk({ oxidevm: context.oxidevm, workspace: context.workspace, workspaceId: "another", bases: context.bases },
      MANIFEST_URL, undefined, "live", release, { imagePreparation: "before-ready", signal: lifetime.signal }))
      .rejects.toMatchObject({ code: "ABORTED" });
    expect(release).not.toHaveBeenCalled();
    expect(context.workspace.find("managed-disks/head.json")).toBeUndefined();
  });
  it("cancels a stalled before-ready chunk before opening a disk generation", async () => {
    const context = storage(), image = await cachedTestImage(context.images, [1]), text = await pinnedManifestText(context, image);
    await context.images.removeEntry(`${managedImageStem(image.ref)}.complete`);
    const entered = Promise.withResolvers<undefined>(), lifetime = new AbortController();
    let fail: ((error: Error) => void) | undefined;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, options?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === MANIFEST_URL) return Promise.resolve(new Response(text));
      return new Promise<Response>((_resolve, reject) => { fail = reject; options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }); entered.resolve(undefined); });
    });
    let released = false;
    const preparing = prepareManagedDisk({ oxidevm: context.oxidevm, workspace: context.workspace, workspaceId: "test", bases: context.bases },
      MANIFEST_URL, undefined, "update-image", () => { released = true; }, { imagePreparation: "before-ready", signal: lifetime.signal });
    try {
      await entered.promise; lifetime.abort();
      const outcome = await Promise.race([preparing.then(() => "admitted", (error: unknown) => error instanceof Error && "code" in error ? error.code : "untyped"),
        new Promise<string>(resolve => setTimeout(() => resolve("not-cancelled"), 50))]);
      expect(outcome).toBe("ABORTED"); expect(released).toBe(false);
    } finally { fail?.(new Error("test cleanup")); await preparing.catch(() => {}); }
  });
  it("refuses same-size cached base corruption before its bytes reach a new workspace's guest", async () => {
    const context = storage(), image = await cachedTestImage(context.images, [1]);
    context.images.file(`${managedImageStem(image.ref)}.pack`, false).setBytes(new Uint8Array(1024 ** 2).fill(9));
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    const prepared=await prepareManagedDisk({ oxidevm: context.oxidevm, workspace: context.workspace, workspaceId: "another", bases: context.bases },
      MANIFEST_URL, undefined, "live", () => {}, { imagePreparation: "before-ready" });
    try {expect(()=>prepared.disk.read(0,new Uint8Array(1))).toThrowError("Cached image chunk is damaged");}
    finally {prepared.disk.close();}
  });
  it("reuses a complete image from another workspace before readiness without probing its server", async () => {
    const context = storage(), image = await cachedTestImage(context.images, [1]);
    const get = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("offline"))); vi.stubGlobal("fetch", get);
    const prepared = await prepareManagedDisk({ oxidevm: context.oxidevm, workspace: context.workspace, workspaceId: "another", bases: context.bases },
      MANIFEST_URL, undefined, "live", () => {}, { imagePreparation: "before-ready" });
    expect(get).not.toHaveBeenCalled(); expect(prepared.image.version).toBe(image.ref.version); prepared.disk.close();
  });
  it("repairs the active immutable image with cancellation, leaving its disk open", async () => {
    const context = storage(), image = await cachedTestImage(context.images, [1]);
    const disk = await openTestDisk(context.workspace.directory("managed-disks", true), context.images, context.bases, image,
      await liveGenerationFor(context.workspace.directory("managed-disks", true), image.ref));
    const get = vi.fn<typeof fetch>(() => Promise.resolve(new Response(KERNEL)));
    vi.stubGlobal("fetch", get);
    await prepareCurrentManagedImage(context.images, "test", image.ref, undefined, undefined, context.bases);
    expect(get).not.toHaveBeenCalled();
    context.images.file(`${managedImageStem(image.ref)}.kernel`, false).setBytes(new Uint8Array(3));
    const lifetime = new AbortController();
    await prepareCurrentManagedImage(context.images, "test", image.ref, undefined, lifetime.signal, context.bases);
    expect(get.mock.calls[0]?.[1]?.signal).toBe(lifetime.signal);
    const bytes = new Uint8Array(4); disk.read(0, bytes);
    expect(bytes).toEqual(new Uint8Array(4).fill(1));
    await prepareCurrentManagedImage(context.images, "test", image.ref, undefined, lifetime.signal, context.bases);
    expect(get).toHaveBeenCalledTimes(1);
    disk.close();
  });
  it("keeps verified partial base chunks and resumes without downloading completed chunks again", async () => {
    const context = storage(), image = await cachedTestImage(context.images, [1, 2]);
    let input = record(JSON.parse(await pinnedManifestText(context, image)) as unknown, "fixture manifest");
    const bodies = await Promise.all([1, 2].map(async fill => new Uint8Array(await new Response(
      new Blob([new Uint8Array(1024 ** 2).fill(fill)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())));
    const disk = record(input["disk"], "fixture disk"), chunks = disk["chunks"];
    if (!Array.isArray(chunks)) throw new Error("missing fixture chunks");
    const authoredChunks = await Promise.all(Array.from<unknown>(chunks).map(async (value, index) => {
      const chunk = record(value, "fixture chunk"), body = bodies[index];
      if (body === undefined) throw new Error("missing encoded chunk");
      return { ...chunk, encodedBytes: body.length, encodedSha256: await sha256Hex(body) };
    }));
    input = { ...input, disk: { ...disk, chunks: authoredChunks } };
    let fail = true;
    const get = vi.fn<typeof fetch>(inputURL => {
      const url = inputURL instanceof Request ? inputURL.url : inputURL instanceof URL ? inputURL.href : inputURL;
      if (url === MANIFEST_URL) return Promise.resolve(new Response(JSON.stringify(input)));
      if (url.endsWith("bzImage")) return Promise.resolve(new Response(KERNEL));
      if (url.endsWith("/disk/1.bin") && fail) return Promise.resolve(new Response(null, { status: 503 }));
      return Promise.resolve(new Response(url.endsWith("/disk/0.bin") ? bodies[0] : bodies[1]));
    });
    vi.stubGlobal("fetch", get);
    await expect(prepare(context, undefined, "update-image")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    fail = false;
    const opened = await prepare(context, undefined, "update-image");
    expect(get.mock.calls.filter(([inputURL]) => (inputURL instanceof Request ? inputURL.url : inputURL instanceof URL ? inputURL.href : inputURL).endsWith("/disk/0.bin"))).toHaveLength(1);
    expect(opened.disk.image.version).toBe(image.manifest.version);
    opened.disk.close();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepares a pinned image from this browser when the network is unreachable", async () => {
    const context = storage();
    const image = await cachedTestImage(context.images, [1, 2]);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    const prepared = await prepare(context);

    expect(prepared.image).toMatchObject({ id: image.ref.id, version: image.ref.version, kernel: KERNEL, aot: { kind: "skipped", reason: "offline" } });
    expect(prepared.disk.image).toEqual(image.ref);
    prepared.disk.close();
  });
  it("refuses an offline cached image whose manifest differs from the caller's exact pin", async () => {
    const context = storage(); await cachedTestImage(context.images, [1, 2]);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    await expect(prepareManagedDisk({ oxidevm: context.oxidevm, workspace: context.workspace, workspaceId: "test", bases: context.bases }, MANIFEST_URL, undefined, "live", () => undefined, {manifestSHA256:"a".repeat(64)})).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("uses the kernel this browser keeps instead of downloading it again", async () => {
    const context = storage();
    const image = await cachedTestImage(context.images, [1]);
    const text = await pinnedManifestText(context, image);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      fetched.push(url);
      return url === MANIFEST_URL ? Promise.resolve(new Response(text)) : Promise.reject(new TypeError("Failed to fetch"));
    });

    const prepared = await prepare(context);

    expect(prepared.image.kernel).toEqual(KERNEL);
    expect(fetched).toEqual([MANIFEST_URL]);
    prepared.disk.close();
  });

  it("downloads the kernel again when the kept copy does not match the image", async () => {
    const context = storage();
    const image = await cachedTestImage(context.images, [1]);
    const text = await pinnedManifestText(context, image);
    context.images.file(`${managedImageStem(image.ref)}.kernel`, true).setBytes(new Uint8Array([0x00, 0x00, 0x00]));
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      fetched.push(url);
      if (url === MANIFEST_URL) return Promise.resolve(new Response(text));
      return Promise.resolve(new Response(KERNEL));
    });

    const prepared = await prepare(context);

    expect(prepared.image.kernel).toEqual(KERNEL);
    expect(fetched).toEqual([MANIFEST_URL, new URL("./bzImage", MANIFEST_URL).href]);
    prepared.disk.close();
  });

  it("prepares offline the version the workspace's disk runs when several are kept", async () => {
    const context = storage();
    const running = await cachedTestImage(context.images, [1], "2026.10.01");
    await cachedTestImage(context.images, [1], "2026.10.02");
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    // The workspace's disk last booted the earlier version.
    const disks = context.workspace.directory("managed-disks", true);
    const booted = await openTestDisk(disks, context.images, context.bases, running, await liveGenerationFor(disks, running.ref));
    booted.close();

    const prepared = await prepare(context);

    expect(prepared.image.version).toBe("2026.10.01");
    prepared.disk.close();
  });

  it("keeps booting the version the workspace's disk runs when the page asks for a newer one", async () => {
    const context = storage();
    const running = await cachedTestImage(context.images, [1], "2026.10.01");
    const newer = await cachedTestImage(context.images, [1], "2026.10.02");
    serveManifest(await pinnedManifestText(context, newer));
    const disks = context.workspace.directory("managed-disks", true);
    const booted = await openTestDisk(disks, context.images, context.bases, running, await liveGenerationFor(disks, running.ref));
    booted.close();

    const live = await prepare(context);
    expect(live.image.version).toBe("2026.10.01");
    expect(live.image.update).toEqual({ id: "test-image", version: "2026.10.02" });
    live.disk.close();
    const restart = await prepare(context, undefined, "pre-resume");
    expect(restart.image.version).toBe("2026.10.01");
    restart.disk.close();

    const updated = await prepare(context, undefined, "update-image");
    expect(updated.image.version).toBe("2026.10.02");
    expect(updated.image.update).toBeUndefined();
    updated.disk.close();
  });

  it("refuses a live boot when the version the workspace's disk runs is no longer kept", async () => {
    const context = storage();
    const newer = await cachedTestImage(context.images, [1], "2026.10.02");
    serveManifest(await pinnedManifestText(context, newer));
    const disks = context.workspace.directory("managed-disks", true);
    const gone = { id: "test-image", version: "2026.10.01", identity: "c".repeat(64) };
    await writeGenerationRecord(disks.directory("g-restored", true), { schema: 1, image: gone, bytes: newer.manifest.disk.bytes, changeBase: null });
    await writeDiskHead(disks, { schema: 1, generation: "g-restored", previous: null, resume: null });

    await expect(prepare(context)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND", detail: { reason: "image-not-cached" } });
    const updated = await prepare(context, undefined, "update-image");
    expect(updated.image.version).toBe("2026.10.02");
    updated.disk.close();
  });

  it("opens the same generation again once the disk running now is released", async () => {
    const context = storage();
    await cachedTestImage(context.images, [1]);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const first = await prepare(context);
    let releases = 0;

    const second = await prepare(context, () => {
      releases += 1;
      first.disk.close();
    });

    expect(releases).toBe(1);
    expect(second.disk.generation).toBe(first.disk.generation);
    second.disk.close();
  });

  it("leaves the disk running now alone when the image cannot be prepared", async () => {
    const context = storage();
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("unavailable", { status: 503 })));
    let releases = 0;

    await expect(prepare(context, () => { releases += 1; })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(releases).toBe(0);
  });

  it("fails offline with a typed error when the image was never kept in this browser", async () => {
    const context = storage();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(prepare(context)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND", detail: { reason: "image-not-cached" } });
  });

  it("does not trust a base pack whose download never completed or was cut short", async () => {
    const context = storage();
    const image = await cachedTestImage(context.images, [1, 2]);
    const stem = managedImageStem(image.ref);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const marker = context.images.file(`${stem}.complete`, false).bytes;

    await context.images.removeEntry(`${stem}.complete`);
    await expect(prepare(context)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND", detail: { reason: "image-not-cached" } });
    context.images.file(`${stem}.complete`, true).setBytes(marker);
    context.images.file(`${stem}.pack`, false).setBytes(new Uint8Array(1024 * 1024));
    await expect(prepare(context)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND", detail: { reason: "image-not-cached" } });
  });
});
