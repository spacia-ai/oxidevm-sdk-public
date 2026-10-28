import { afterEach, expect, it, vi } from "vitest";
import { retainRootfsRead } from "./rootfs-read-lock.js";

afterEach(() => vi.unstubAllGlobals());

it("retains the shared lifecycle lock until the read owner retires it", async () => {
  let readers = 0;
  const request = vi.fn(async (_name: string, options: LockOptions, work: (lock: object | null) => Promise<void> | undefined) => {
    if (options.mode === "exclusive") { await work(readers === 0 ? {} : null); return; }
    readers++; try { return await work({}); } finally { readers--; }
  });
  vi.stubGlobal("navigator", { locks: { request } });
  const release = await retainRootfsRead();
  expect(readers).toBe(1);
  const collected = vi.fn((lock: object | null) => { if (lock !== null) throw new Error("GC reclaimed an admitted image read"); return undefined; });
  await request("oxidevm-rootfs-pack-lifecycle", { mode: "exclusive", ifAvailable: true }, collected);
  expect(collected).toHaveBeenCalledWith(null);
  await release(); await release();
  expect(readers).toBe(0);
});

it("keeps a borrowed file protected after its verification transaction retires", async () => {
  let readers = 0;
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: LockOptions, work: () => Promise<undefined>) => {
    readers++; try { await work(); } finally { readers--; }
  } } });
  const transaction = await retainRootfsRead();
  const releaseFile = transaction.borrow();
  await transaction();
  expect(readers).toBe(1);
  await releaseFile();
  expect(readers).toBe(0);
});

it("rejects cancelled admission without acquiring a read lock", async () => {
  const request = vi.fn(); vi.stubGlobal("navigator", { locks: { request } });
  await expect(retainRootfsRead(AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
  expect(request).not.toHaveBeenCalled();
});
