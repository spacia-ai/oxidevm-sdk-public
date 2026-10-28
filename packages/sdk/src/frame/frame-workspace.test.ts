import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceChange } from "../contracts.js";
import { FrameChannel } from "./client/channel.js";
import { closeChannels, connect, fakeVM, rejection } from "./frame-vm.test-support.js";
import { decodeUnit } from "./protocol/values.js";

afterEach(closeChannels);

const bytes = (text: string) => new TextEncoder().encode(text);

/** Resolves once the page has seen `count` change batches. */
function collector() {
  const batches: (readonly WorkspaceChange[])[] = [];
  let waiting: { count: number; resolve: () => void } | undefined;
  return {
    batches,
    onChange: (changes: readonly WorkspaceChange[]) => {
      batches.push(changes);
      if (waiting !== undefined && batches.length >= waiting.count) waiting.resolve();
    },
    seen: (count: number) => new Promise<void>(resolve => { if (batches.length >= count) resolve(); else waiting = { count, resolve }; }),
  };
}

describe("runtime frame workspace", () => {
  it("round-trips entries, stat, bounded reads, conditional writes, directories and renames", async () => {
    const { client } = await connect(fakeVM().vm);
    const written = await client.workspace.write("/a.txt", bytes("hi"), { ifVersion: null });
    expect(written).toEqual({ kind: "file", link: null, name: "a.txt", path: "/a.txt", size: 2, version: "1".padStart(48, "0") });
    const rewritten = await client.workspace.write("/a.txt", bytes("hey"), { ifVersion: written.version });
    expect(rewritten.version).toBe("2".padStart(48, "0"));
    await client.workspace.createDirectory("/src");
    await client.workspace.rename("/a.txt", "/src/b.txt");
    expect(await client.workspace.entries()).toEqual([{ kind: "directory", link: null, name: "src", path: "/src", size: 0, version: "f".repeat(48) }]);
    expect(await client.workspace.entries("/src")).toEqual([{ ...rewritten, name: "b.txt", path: "/src/b.txt" }]);
    expect(await client.workspace.stat("/src/b.txt")).toEqual({ ...rewritten, name: "b.txt", path: "/src/b.txt" });
    // The frame sends only an entry's wire fields, so the page decodes it exactly.
    expect(await client.workspace.read("/src/b.txt", { maxBytes: 3 })).toEqual({ entry: { ...rewritten, name: "b.txt", path: "/src/b.txt" }, data: bytes("hey") });
    expect(await client.workspace.read("/src/b.txt")).toMatchObject({ data: bytes("hey") });
  });

  it("keeps the frame workspace's typed failures", async () => {
    const { client } = await connect(fakeVM().vm);
    const first = await client.workspace.write("/a", bytes("abc"));
    expect(await rejection(client.workspace.read("/a", { maxBytes: 2 }))).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "too-large", size: 3 } });
    expect(await rejection(client.workspace.write("/a", bytes("x"), { ifVersion: null }))).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "exists" } });
    expect(await rejection(client.workspace.write("/a", bytes("x"), { ifVersion: "e".repeat(48) }))).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "version-mismatch" } });
    expect(await client.workspace.write("/a", bytes("x"), { ifVersion: first.version })).toMatchObject({ size: 1 });
    expect((await rejection(client.workspace.stat("/missing"))).code).toBe("STORAGE_NOT_FOUND");
    expect((await rejection(client.workspace.rename("/missing", "/b"))).code).toBe("STORAGE_NOT_FOUND");
  });

  it("refuses limits the wire bounds with the workspace's own INVALID_ARGUMENT before sending", async () => {
    const { client } = await connect(fakeVM().vm);
    expect((await rejection(client.workspace.read("/a", { maxBytes: -1 }))).code).toBe("INVALID_ARGUMENT");
    expect((await rejection(client.workspace.read("/a", { maxBytes: 16 * 1024 ** 2 + 1 }))).code).toBe("INVALID_ARGUMENT");
    expect((await rejection(client.workspace.write("/a", bytes("x"), { ifVersion: "not-a-version" }))).code).toBe("INVALID_ARGUMENT");
    const controller = new AbortController();
    const watch = client.workspace.watch(() => undefined, { signal: controller.signal });
    expect((await rejection(watch.setDirectories(Array.from({ length: 257 }, (_, index) => `/d${String(index)}`)))).code).toBe("INVALID_ARGUMENT");
    controller.abort();
    await watch.done;
  });

  it("delivers watched changes, forwards setDirectories to the frame's watch and ends it when the page aborts", async () => {
    const { vm, watches } = fakeVM();
    const { client } = await connect(vm);
    const controller = new AbortController();
    const seen = collector();
    const watch = client.workspace.watch(seen.onChange, { signal: controller.signal });
    await watch.setDirectories(["/src", "/", "/src"]);
    const held = watches[0];
    if (held === undefined) throw new Error("the frame did not start a watch");
    expect(held.directories).toEqual([["/src", "/"]]);
    held.emit([{ kind: "changed", directory: "/src", name: "a.txt" }]);
    held.emit([{ kind: "rescan" }]);
    await seen.seen(2);
    expect(seen.batches).toEqual([[{ kind: "changed", directory: "/src", name: "a.txt" }], [{ kind: "rescan" }]]);
    controller.abort();
    await watch.done;
    await held.ended;
    expect((await rejection(watch.setDirectories(["/src"]))).code).toBe("ABORTED");
    // The channel stays usable after the watch ends.
    expect(await client.workspace.entries()).toEqual([]);
  });

  it("turns a change batch larger than one event into a rescan", async () => {
    const { vm, watches } = fakeVM();
    const { client } = await connect(vm);
    const controller = new AbortController();
    const seen = collector();
    const watch = client.workspace.watch(seen.onChange, { signal: controller.signal });
    await watch.setDirectories(["/"]);
    watches[0]?.emit(Array.from({ length: 1025 }, (_, index) => ({ kind: "changed", directory: "/", name: `f${String(index)}` })));
    await seen.seen(1);
    expect(seen.batches).toEqual([[{ kind: "rescan" }]]);
    controller.abort();
    await watch.done;
  });

  it("rejects a watch's done with the frame watch's failure", async () => {
    const { vm, watches } = fakeVM();
    const { client } = await connect(vm);
    const watch = client.workspace.watch(() => undefined, { signal: new AbortController().signal });
    await watch.setDirectories(["/"]);
    watches[0]?.fail(new Error("inotify went away"));
    const failure = await rejection(watch.done);
    expect(failure.message).toContain("inotify went away");
  });

  it("ends a watch at once when its signal is already aborted", async () => {
    const { vm, watches } = fakeVM();
    const { client } = await connect(vm);
    const controller = new AbortController();
    controller.abort();
    const watch = client.workspace.watch(() => undefined, { signal: controller.signal });
    await watch.done;
    expect(watches).toEqual([]);
    expect((await rejection(watch.setDirectories(["/"]))).code).toBe("ABORTED");
  });

  it("cancels a workspace call in the frame when the page aborts it mid-call", async () => {
    const { client } = await connect(fakeVM().vm);
    for (const call of [
      (signal: AbortSignal) => client.workspace.stat("/slow", signal),
      (signal: AbortSignal) => client.workspace.read("/slow", { signal }),
    ]) {
      const controller = new AbortController();
      const pending = call(controller.signal);
      controller.abort();
      expect((await rejection(pending)).code).toBe("ABORTED");
    }
    expect(await client.workspace.write("/b", bytes("ok"))).toMatchObject({ path: "/b" });
  });

  it("fails pending workspace calls and ends watches with PROTOCOL_ERROR when the frame goes away", async () => {
    const { client, channel } = await connect(fakeVM().vm);
    const watch = client.workspace.watch(() => undefined, { signal: new AbortController().signal });
    await watch.setDirectories(["/"]);
    const statting = client.workspace.stat("/slow");
    channel.port2.close();
    channel.port1.dispatchEvent(new Event("close"));
    expect((await rejection(statting)).code).toBe("PROTOCOL_ERROR");
    expect((await rejection(watch.done)).code).toBe("PROTOCOL_ERROR");
    expect((await rejection(watch.setDirectories(["/src"]))).code).toBe("PROTOCOL_ERROR");
    expect((await rejection(client.workspace.entries())).code).toBe("PROTOCOL_ERROR");
  });

  it("fails a request instead of waiting when the frame answers in another protocol version", async () => {
    const { port1, port2 } = new MessageChannel();
    port2.addEventListener("message", (event: MessageEvent<unknown>) => {
      const id = typeof event.data === "object" && event.data !== null && "id" in event.data ? event.data.id : 0;
      port2.postMessage({ v: 1, type: "result", id, ok: true, value: null });
    });
    port2.start();
    const channel = new FrameChannel(port1);
    try {
      expect((await rejection(channel.request({ type: "workspace.stat", path: "/" }, { decode: decodeUnit }))).code).toBe("PROTOCOL_ERROR");
    } finally { channel.close(); port2.close(); }
  });
});
