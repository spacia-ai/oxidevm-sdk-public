import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VMError } from "./errors.js";

import { createRuntimeVM } from "./index.js";
import type * as PreviewSession from "./preview-session.js";
import type { PreviewSessionOptions } from "./preview-session.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import type { ListeningPortsRead } from "./listening-ports.js";
import type { ListeningPort, PreviewHandle } from "./vm-types.js";

/** A replacement for opening a session, per test; without one the real module runs. */
const preview = vi.hoisted(() => {
  const state: { open?: (options: PreviewSessionOptions) => Promise<PreviewHandle> } = {};
  return state;
});

/** The backend's answers to listening-port reads, per test, and the generations it was given. */
const listening = vi.hoisted(() => {
  const state: { reads: ListeningPortsRead[]; known: (bigint | null)[] } = { reads: [], known: [] };
  return state;
});

vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return ({
  UserspaceProcessBackend: {
    create: () => Promise.resolve({
      ...nativeBackend(),
      listeningPorts: (known: bigint | null) => {
        listening.known.push(known);
        return Promise.resolve(listening.reads.shift() ?? { generation: 9n, ports: null });
      },
    }),
  },
}); });

vi.mock("./preview-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PreviewSession>();
  return {
    ...actual,
    openPreviewSession: (options: PreviewSessionOptions): Promise<PreviewHandle> => preview.open === undefined ? actual.openPreviewSession(options) : preview.open(options),
  };
});

const userspace = (previewOrigin: string) => createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local", previewOrigin });

describe("Userspace previews", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    delete preview.open;
    listening.reads = [];
    listening.known = [];
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("rejects exposePort for an invalid preview host instead of throwing", async () => {
    const vm = await userspace("http://127.0.0.1:4273");
    let result: Promise<PreviewHandle> | undefined;
    expect(() => { result = vm.exposePort(3000); }).not.toThrow();
    await expect(result).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects exposePort on a disposed VM instead of throwing", async () => {
    const vm = await userspace("http://localhost:4273");
    await vm.dispose();
    let result: Promise<PreviewHandle> | undefined;
    expect(() => { result = vm.exposePort(3000); }).not.toThrow();
    await expect(result).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("closing a preview frees the VM for the next port without waiting", async () => {
    const opened: number[] = [];
    preview.open = (options) => {
      opened.push(options.port);
      return Promise.resolve({ url: new URL(`http://${"a".repeat(32)}.localhost:4273/`), close: () => new Promise<void>(() => undefined) });
    };
    const vm = await userspace("http://localhost:4273");
    const first = await vm.exposePort(3000);
    void first.close();
    await expect(vm.exposePort(4000)).resolves.toMatchObject({ url: new URL(`http://${"a".repeat(32)}.localhost:4273/`) });
    expect(opened).toEqual([3000, 4000]);
  });
  it("keeps distinct guest ports on independently owned preview sessions", async () => {
    const opened: number[] = [];
    preview.open = options => { opened.push(options.port); return Promise.resolve({ url: new URL(`http://${"a".repeat(32)}.localhost:4273/`), close: () => Promise.resolve() }); };
    const vm = await userspace("http://localhost:4273");
    const first = await vm.exposePort(3000); const second = await vm.exposePort(4000);
    expect(opened).toEqual([3000, 4000]); await first.close(); await second.close(); await vm.dispose();
  });
  it("still terminates every worker when a preview fails to close", async () => {
    const terminated = vi.spyOn(ScriptedWorker.prototype, "terminate");
    preview.open = () => Promise.resolve({ url: new URL(`http://${"a".repeat(32)}.localhost:4273/`), close: () => Promise.reject(new VMError("RELAY_ERROR", "close failed")) });
    const vm = await userspace("http://localhost:4273"); await vm.exposePort(3000);
    await expect(vm.dispose()).rejects.toMatchObject({ code: "RELAY_ERROR" });
    expect(terminated.mock.contexts).toEqual(expect.arrayContaining(ScriptedWorker.instances));
    terminated.mockRestore();
  });

  it("shares disposal completion and releases workers after preview close fails", async () => {
    preview.open = () => Promise.resolve({ url: new URL("http://localhost:4273/"), close: () => Promise.reject(new Error("preview close failed")) });
    const vm = await userspace("http://localhost:4273");
    await vm.exposePort(3000);
    const workers = [...ScriptedWorker.instances];
    const terminated = workers.map(worker => vi.spyOn(worker, "terminate"));
    const first = vm.dispose();
    const second = vm.dispose();
    const results = await Promise.allSettled([first, second]);
    expect(second).toBe(first);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "preview close failed" } });
    expect(results[1]).toEqual(results[0]);
    expect(workers.find(worker => worker.options.name === "oxidevm-storage")?.operations).toContain("dispose");
    for (const termination of terminated) expect(termination).toHaveBeenCalled();
  });

  const app: ListeningPort = { port: 3000, address: "0.0.0.0", program: "bun dev", previewable: true };

  it("lists the ports apps listen on in Userspace", async () => {
    listening.reads = [{ generation: 1n, ports: [app] }];
    const vm = await userspace("http://localhost:4273");
    await expect(vm.listeningPorts()).resolves.toEqual([app]);
    expect(listening.known).toEqual([null]);
  });

  it("watches listening ports until its signal aborts", async () => {
    listening.reads = [{ generation: 1n, ports: [app] }];
    const vm = await userspace("http://localhost:4273");
    const controller = new AbortController();
    const seen: (readonly ListeningPort[])[] = [];
    await vm.watchListeningPorts((ports) => { seen.push(ports); controller.abort(); }, { signal: controller.signal });
    expect(seen).toEqual([[app]]);
  });

  it("rejects listening-port calls on a disposed VM", async () => {
    const vm = await userspace("http://localhost:4273");
    await vm.dispose();
    await expect(vm.listeningPorts()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(vm.watchListeningPorts(() => undefined, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("stops watching with PROTOCOL_ERROR when the VM is disposed meanwhile", async () => {
    listening.reads = [{ generation: 1n, ports: [app] }];
    const vm = await userspace("http://localhost:4273");
    const watching = vm.watchListeningPorts(() => { void vm.dispose(); }, { signal: new AbortController().signal });
    await expect(watching).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});
