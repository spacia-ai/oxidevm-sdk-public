import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdvancedTestVM as createSystemRuntimeVM, ScriptedWorker } from "./system-vm.test-support.js";
import { integer, record } from "./decode.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { ManagedSession } from "./managed-session.js";
import { VMError } from "./errors.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

describe("system storage transport selection", () => {
  afterEach(() => { ScriptedWorker.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("cancels explicit update discovery when disposal starts",async()=>{
    vi.stubGlobal("Worker",ScriptedWorker);
    const updating=vi.spyOn(ManagedSession.prototype,"checkForUpdate").mockImplementation(signal=>new Promise((_,reject)=>{
      signal?.addEventListener("abort",()=>reject(new VMError("ABORTED","Update cancelled")),{once:true});
    }));
    const vm=await createSystemRuntimeVM({mode:"system",workspaceId:"update-disposal",memoryMiB:64,vcpus:1,network:"local"});
    if(vm.checkForUpdate===undefined)throw new Error("System update discovery is unavailable");
    const result=vm.checkForUpdate(),checked=expect(result).rejects.toMatchObject({code:"ABORTED"});
    await vm.dispose();
    expect(updating.mock.calls[0]?.[0]?.aborted).toBe(true);
    await checked;
  });
  it.each(["opfs", "indexeddb"])("selects the disk transport from the actual %s storage backend", async persistence => {
    vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("crossOriginIsolated", true);
    ScriptedWorker.answers.set("workspace-persistence", () => persistence);
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "backend-selection", memoryMiB: 64, vcpus: 1, network: "local" });
    const initialized = ScriptedWorker.named("oxidevm-control").inputs.find(input => input["type"] === "initialize");
    expect(initialized?.["diskBridge"] instanceof SharedArrayBuffer).toBe(persistence === "opfs");
    expect(ScriptedWorker.named("oxidevm-storage").operations).toContain("workspace-persistence");
    await vm.dispose();
  });
});

class DisposalWorker extends EventTarget {
  static readonly instances: DisposalWorker[] = [];
  readonly ports: MessagePort[] = [];
  readonly operations: unknown[] = [];
  pending: number | undefined;
  silentAssistance = false;
  terminated = false;
  constructor(_url: URL, readonly options: WorkerOptions) {
    super(); DisposalWorker.instances.push(this);
  }
  postMessage(value: unknown, transfer: readonly Transferable[]): void {
    for (const item of transfer) if (item instanceof MessagePort) this.ports.push(item);
    const input = record(value, "test worker request");
    if (input["type"] === "connect-system") { this.operations.push(input["type"]); return; }
    const id = integer(input["id"], "id", 1, 0xffff_ffff);
    this.operations.push(input["type"]);
    if (input["type"] === "assistance-network-attach" || input["type"] === "assistance-network-failed" || input["type"] === "assistance-dispose") {
      if (this.silentAssistance) return;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id, version: PROTOCOL_VERSION, ok: true, value: undefined } })));
      return;
    }
    if (input["type"] === "dispose") { this.pending = id; return; }
    if (input["type"] !== "initialize") throw new Error("unexpected operation");
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
      id, version: PROTOCOL_VERSION, ok: true,
      value: this.options.name === "oxidevm-control"
        ? { execution: "serialized", vcpus: 1, sharedMemory: false } : undefined,
    } })));
  }
  finish(failure: boolean): void {
    if (this.pending === undefined) throw new Error("no pending disposal");
    this.dispatchEvent(new MessageEvent("message", { data: failure
      ? { id: this.pending, version: PROTOCOL_VERSION, ok: false, error: { code: "STORAGE_ERROR", message: "fixture failure" } }
      : { id: this.pending, version: PROTOCOL_VERSION, ok: true, value: undefined },
    }));
    this.pending = undefined;
  }
  terminate(): void { this.terminated = true; for (const port of this.ports) port.close(); }
}

describe("system VM disposal", () => {
  afterEach(() => {
    for (const worker of DisposalWorker.instances.splice(0)) worker.terminate();
    vi.unstubAllGlobals();
  });
  it("does not start dependency preparation before a managed workspace is booted", async () => {
    vi.stubGlobal("Worker", DisposalWorker);
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "preparation", memoryMiB: 64, vcpus: 1, network: "local",
      assistance: { executionOrigin: "https://execution.example.test", manifestUrl: "https://execution.example.test/manifest.json" } });
    await expect(vm.prepareDependencies()).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    const [control, storage] = DisposalWorker.instances;
    if (control === undefined || storage === undefined) throw new Error("workers missing");
    expect(control.operations).toEqual(["initialize", "assistance-network-attach"]);
    const disposed = vm.dispose();
    await vi.waitFor(() => expect(control.pending).toBeDefined()); control.finish(false);
    await vi.waitFor(() => expect(storage.pending).toBeDefined()); storage.finish(false);
    await disposed;
  });
  it("connects an admitted VM to its network worker and reports owner loss to control", async () => {
    vi.stubGlobal("Worker", DisposalWorker);
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "network", memoryMiB: 64, vcpus: 1, network: "local",
      assistance: { executionOrigin: "https://execution.example.test", manifestUrl: "https://execution.example.test/manifest.json" } });
    const [control, storage, network] = DisposalWorker.instances;
    if (control === undefined || storage === undefined || network === undefined) throw new Error("network worker missing");
    expect(network.options.name).toBe("oxidevm-network");
    expect(network.operations).toEqual(["connect-system"]);
    expect(control.operations).toEqual(["initialize", "assistance-network-attach"]);
    network.dispatchEvent(new Event("error"));
    network.dispatchEvent(new Event("messageerror"));
    expect(control.operations.filter(operation => operation === "assistance-network-failed")).toHaveLength(1);
    const disposed = vm.dispose();
    await vi.waitFor(() => expect(control.pending).toBeDefined()); control.finish(false);
    await vi.waitFor(() => expect(storage.pending).toBeDefined()); storage.finish(false);
    await disposed;
    expect(network.terminated).toBe(true);
  });
  it.each([false, true])("shares the complete cleanup outcome (failure=%s)", async failure => {
    vi.stubGlobal("Worker", DisposalWorker);
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "disposal", memoryMiB: 64, vcpus: 1, network: "local" });
    const first = vm.dispose();
    const second = vm.dispose();
    const outcomes = Promise.allSettled([first, second]);
    const [control, storage] = DisposalWorker.instances;
    if (control === undefined || storage === undefined) throw new Error("workers missing");
    await vi.waitFor(() => expect(control.pending).toBeDefined());
    expect(control.operations).toEqual(["initialize", "assistance-dispose", "dispose"]);
    control.finish(failure);
    await vi.waitFor(() => expect(storage.pending).toBeDefined());
    storage.finish(false);
    const result = await outcomes;
    expect(second).toBe(first);
    expect(result[1]).toEqual(result[0]);
    expect(result[0].status).toBe(failure ? "rejected" : "fulfilled");
    expect(control.terminated && storage.terminated).toBe(true);
    expect(vm.dispose()).toBe(first);
  });
  it("fails a silent assistance shutdown and still releases storage ownership", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", DisposalWorker);
    try {
      const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "silent-disposal", memoryMiB: 64, vcpus: 1, network: "local" });
      const [control, storage] = DisposalWorker.instances;
      if (control === undefined || storage === undefined) throw new Error("workers missing");
      control.silentAssistance = true;
      const first = vm.dispose();
      const result = Promise.allSettled([first, vm.dispose()]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(control.terminated).toBe(true);
      expect(storage.pending).toBeDefined();
      storage.finish(false);
      const outcomes = await result;
      expect(outcomes[0]).toMatchObject({ status: "rejected", reason: { code: "GUEST_CRASH", message: "Assisted task retirement timed out" } });
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(storage.terminated).toBe(true);
    } finally { vi.useRealTimers(); }
  });

});
