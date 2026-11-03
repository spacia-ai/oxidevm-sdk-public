import { afterEach, describe, expect, it, vi } from "vitest";
import { digest } from "../../../wasm/runner/fixtures.test-support.js";
import { copyKey, MODULE_COPY_BYTES } from "../../protocol/userspace-module-files.js";
import { ModuleCopies, type CopyRequest } from "./module-copies.js";

afterEach(() => { vi.restoreAllMocks(); });

const live = (): AbortSignal => new AbortController().signal;
const ADAPTER = new TextEncoder().encode("export default () => ({ main: () => 0 });");
const DATA = Uint8Array.of(1, 2, 3, 4);

async function file(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<CopyRequest & { readonly blob: Blob }> {
  return { file: name, pin: { sha256: await digest(bytes), bytes: bytes.byteLength }, blob: new Blob([bytes]) };
}

function supplied(files: readonly (CopyRequest & { readonly blob: Blob })[]): ReadonlyMap<string, Blob> {
  return new Map(files.map(entry => [copyKey(entry.pin), entry.blob]));
}

describe("verified module copies", () => {
  it("verify once", async () => {
    const files = [await file("adapter.mjs", ADAPTER), await file("data.bin", DATA)], store = new ModuleCopies();
    const hash = vi.spyOn(crypto.subtle, "digest");
    const first = await store.hold({ kind: "registration", id: 1 }, files, supplied(files), live());
    // A second holder supplies nothing: the store already holds every copy and hashes nothing again.
    expect(store.missing(files.map(entry => entry.pin))).toEqual([]);
    const second = await store.hold({ kind: "spawn" }, files, new Map(), live());
    expect(hash).toHaveBeenCalledTimes(2);
    expect(second.get(copyKey(files[1]?.pin ?? { sha256: "", bytes: 0 }))).toBe(first.get(copyKey(files[1]?.pin ?? { sha256: "", bytes: 0 })));
    expect(new Uint8Array(await second.get(copyKey(files[0]?.pin ?? { sha256: "", bytes: 0 }))?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(ADAPTER);
    expect(store.bytes).toBe(ADAPTER.byteLength + DATA.byteLength);
  });

  it("altered bytes give wasm-module-integrity with detail.file", async () => {
    const data = await file("data.bin", DATA), store = new ModuleCopies();
    const altered = new Map([[copyKey(data.pin), new Blob([Uint8Array.of(1, 2, 3, 5)])]]);
    await expect(store.hold({ kind: "spawn" }, [data], altered, live())).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" } });
    const short = new Map([[copyKey(data.pin), new Blob([Uint8Array.of(1, 2, 3)])]]);
    await expect(store.hold({ kind: "spawn" }, [data], short, live())).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" } });
    // Nothing is kept: the next start must supply the file again, and the budget is free.
    expect(store.missing([data.pin])).toEqual([copyKey(data.pin)]);
    expect(store.bytes).toBe(0);
  });

  it("a damaged file beside held ones still gives wasm-module-integrity naming it", async () => {
    // Found by module-copies.differential.test.ts (seed 12): the damaged copy's failed check removed it from the store
    // while the hold was still waiting for the held copies, and the hold then failed as a PROTOCOL_ERROR without a file.
    const held = [await file("adapter.mjs", ADAPTER), await file("one.bin", Uint8Array.of(1)), await file("two.bin", Uint8Array.of(2))];
    const data = await file("data.bin", DATA), store = new ModuleCopies();
    await store.hold({ kind: "spawn" }, held, supplied(held), live());
    const longer = new Map([[copyKey(data.pin), new Blob([Uint8Array.of(...DATA, 0)])]]);
    await expect(store.hold({ kind: "spawn" }, [...held, data], longer, live())).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" } });
    expect(store.missing([...held, data].map(entry => entry.pin))).toEqual([copyKey(data.pin)]);
  });

  it("neither held nor supplied is refused", async () => {
    const data = await file("data.bin", DATA), other = await file("other.bin", Uint8Array.of(7)), store = new ModuleCopies();
    const hash = vi.spyOn(crypto.subtle, "digest");
    await expect(store.hold({ kind: "spawn" }, [data], new Map(), live())).rejects.toMatchObject({ code: "PROTOCOL_ERROR", detail: { reason: "wasm-module-copy-missing", file: "data.bin" } });
    // A Blob for a key the request does not name is refused too: the page sends only what the VM lacks.
    await expect(store.hold({ kind: "spawn" }, [data], supplied([data, other]), live())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(hash).not.toHaveBeenCalled();
  });

  it("the 512 MiB budget is counted before hashing", async () => {
    const store = new ModuleCopies(), hash = vi.spyOn(crypto.subtle, "digest");
    const data = await file("data.bin", DATA);
    await store.hold({ kind: "registration", id: 1 }, [data], supplied([data]), live());
    // The pins claim the bytes; a request beyond the budget is refused before any supplied byte is read.
    const huge: CopyRequest = { file: "huge.bin", pin: { sha256: "a".repeat(64), bytes: MODULE_COPY_BYTES - DATA.byteLength + 1 } };
    const readBlob = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    const blob = new Blob([]);
    Reflect.set(blob, "arrayBuffer", readBlob);
    hash.mockClear();
    await expect(store.hold({ kind: "spawn" }, [huge], new Map([[copyKey(huge.pin), blob]]), live())).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", detail: { reason: "wasm-module-copy-limit" } });
    expect(hash).not.toHaveBeenCalled();
    expect(readBlob).not.toHaveBeenCalled();
    // Copies released by their last holder free the budget.
    store.release({ kind: "registration", id: 1 });
    expect(store.bytes).toBe(0);
  });

  it("spawn holds last until dispose", async () => {
    const data = await file("data.bin", DATA), adapter = await file("adapter.mjs", ADAPTER), store = new ModuleCopies();
    await store.hold({ kind: "registration", id: 3 }, [data, adapter], supplied([data, adapter]), live());
    await store.hold({ kind: "spawn" }, [data], new Map(), live());
    // Turning the commands off drops the copies only they held.
    store.release({ kind: "registration", id: 3 });
    expect(store.missing([data.pin, adapter.pin])).toEqual([copyKey(adapter.pin)]);
    // The VM-wide spawn holder is never released before the VM goes.
    store.release({ kind: "spawn" });
    expect(store.missing([data.pin])).toEqual([]);
    store.dispose();
    expect(store.missing([data.pin])).toEqual([copyKey(data.pin)]);
    expect(store.bytes).toBe(0);
  });

  it("concurrent holds verify once", async () => {
    const files = [await file("adapter.mjs", ADAPTER), await file("data.bin", DATA)], store = new ModuleCopies();
    const hash = vi.spyOn(crypto.subtle, "digest");
    const [one, two] = await Promise.all([
      store.hold({ kind: "registration", id: 1 }, files, supplied(files), live()),
      store.hold({ kind: "spawn" }, files, supplied(files), live()),
    ]);
    expect(hash).toHaveBeenCalledTimes(2);
    for (const entry of files) expect(one.get(copyKey(entry.pin))).toBe(two.get(copyKey(entry.pin)));
  });

  it("a cancelled hold keeps nothing it alone needed", async () => {
    const data = await file("data.bin", DATA), store = new ModuleCopies(), cancel = new AbortController();
    const holding = store.hold({ kind: "spawn" }, [data], supplied([data]), cancel.signal);
    cancel.abort();
    await expect(holding).rejects.toMatchObject({ code: "ABORTED" });
    expect(store.bytes).toBe(0);
  });
});
