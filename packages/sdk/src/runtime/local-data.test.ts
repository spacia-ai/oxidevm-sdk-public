import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLocalDataLease } from "./index.js";
import { eraseLocalData } from "./local-data.js";
import { ScriptedWorker } from "./system-vm.test-support.js";

describe("standalone SDK local data erasure", () => {
  afterEach(() => { ScriptedWorker.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("uses a fresh storage owner and retires it on success or failure", async () => {
    vi.stubGlobal("Worker", ScriptedWorker);
    const terminate = vi.spyOn(ScriptedWorker.prototype, "terminate");
    ScriptedWorker.answers.set("erase-local-data", () => undefined);
    await eraseLocalData();
    expect(ScriptedWorker.instances).toHaveLength(1);
    const worker = ScriptedWorker.named("oxidevm-local-data-reset");
    expect(worker.operations).toEqual(["erase-local-data"]);
    expect(terminate).toHaveBeenCalledTimes(1);
    ScriptedWorker.reset();
    terminate.mockClear();
    ScriptedWorker.answers.set("erase-local-data", () => { throw new Error("storage blocked"); });
    await expect(eraseLocalData()).rejects.toThrow("storage blocked");
    expect(ScriptedWorker.named("oxidevm-local-data-reset").operations).toEqual(["erase-local-data"]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
  it("does not start a worker for a cancelled or invalid request", async () => {
    vi.stubGlobal("Worker", ScriptedWorker);
    await expect(eraseLocalData({ signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(Reflect.apply(eraseLocalData, undefined, [{ signal: "untrusted" }])).rejects.toThrow();
    await expect(Reflect.apply(eraseLocalData, undefined, [{ force: true }])).rejects.toThrow();
    expect(ScriptedWorker.instances).toHaveLength(0);
  });
  it("terminates the erasing worker when cancellation interrupts a pending operation", async () => {
    vi.stubGlobal("Worker", ScriptedWorker);
    ScriptedWorker.answers.set("erase-local-data", () => new Promise<undefined>(() => undefined));
    const terminate = vi.spyOn(ScriptedWorker.prototype, "terminate");
    const controller = new AbortController();
    const clearing = eraseLocalData({ signal: controller.signal });
    controller.abort();
    await expect(clearing).rejects.toMatchObject({ code: "ABORTED" });
    expect(terminate).toHaveBeenCalledTimes(1);
  });
  it("lets application writers keep a shared lease without starting a VM", async () => {
    const first = await acquireLocalDataLease();
    const second = await acquireLocalDataLease();
    await first(); await second();
    expect(ScriptedWorker.instances).toHaveLength(0);
  });
});

// Compiled with the strict SDK test project; never run these destructive examples in a test.
function examples(signal: AbortSignal): readonly Promise<void>[] {
  // @ts-expect-error Erasure cannot force another active VM to release storage.
  const forced = eraseLocalData({ force: true });
  // @ts-expect-error Erasure is origin-wide, never a disguised workspace reset.
  const partial = eraseLocalData({ workspaceId: "playground" });
  return [eraseLocalData(), eraseLocalData({ signal }), forced, partial];
}
it("compiler-checks the positive and negative SDK erasure examples", () => expect(typeof examples).toBe("function"));
