import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { ASSISTANCE_ARTIFACTS } from "./assistance-build.js";
import { SystemAssistance } from "./workers/control/assistance.js";
import { decodeBrokerCommand } from "./protocol/assistance-broker.js";
import type { AssistanceReply } from "./protocol/assistance-reply.js";
import { createRuntimeVM } from "./index.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";
import { WORKSPACE_HANDOFF_VERSION, requestWorkspaceHandoff, workspaceHandoffChannelName, type WorkspaceMovedAway } from "./workspace-handoff.js";
import type { RuntimeVM } from "./vm-types.js";
import { workspaceLockName } from "./workspace-path.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: {
  version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1",
  nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } },
  compiler: { sha256: "0".repeat(64), bytes: 1 }, runtime: { sha256: "0".repeat(64), bytes: 1 },
} }));
vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return { UserspaceProcessBackend: { create: () => Promise.resolve(nativeBackend()) } };
});

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174099";

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Another tab asking for `workspaceId`: what it heard back, after `settle()`. */
function askFor(workspaceId: string): { readonly heard: unknown[]; readonly close: () => void } {
  const channel = new BroadcastChannel(workspaceHandoffChannelName(workspaceId));
  const heard: unknown[] = [];
  channel.addEventListener("message", (event: MessageEvent<unknown>) => heard.push(event.data));
  channel.postMessage({ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-request", requestId: REQUEST_ID });
  return { heard, close: () => { channel.close(); } };
}

/** Allows `vm` to hand its workspace over and collects what it reports. */
function allow(vm: RuntimeVM, signal = new AbortController().signal): WorkspaceMovedAway[] {
  const moved: WorkspaceMovedAway[] = [];
  vm.allowWorkspaceHandoff((event) => moved.push(event), { signal });
  return moved;
}

/** The real workspace lock outlives a refused handoff, just as storage's lock does. */
async function holdWorkspace(workspaceId: string): Promise<() => void> {
  const held = Promise.withResolvers<undefined>();
  const granted = Promise.withResolvers<undefined>();
  void navigator.locks.request(workspaceLockName(workspaceId), async () => {
    granted.resolve(undefined);
    await held.promise;
  });
  await granted.promise;
  return () => { held.resolve(undefined); };
}

/** Real admission and irreversible retirement, behind the scripted control transport. */
function assistanceOwner(version: 4 | 6 = 4): SystemAssistance {
  return new SystemAssistance({
    supportsAssistance: true, assistanceVersion: version,
    creditAssistance: (_id, credit) => Promise.resolve(credit),
    setInstallationEvents: vi.fn(), setAssistanceEvents: vi.fn(),
    startInstallation: () => Promise.reject(new Error("unexpected installation")),
    installation: () => Promise.reject(new Error("unexpected installation")),
    superviseAssistance: () => Promise.resolve(), checkAssistanceHealth: () => Promise.resolve(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
}

function useAssistanceOwner(owner: SystemAssistance): void {
  ScriptedWorker.answers.set("assistance-dispose", () => owner.dispose());
  ScriptedWorker.answers.set("agent-sync-workspace", () => { owner.assertIdle(); return true; });
  ScriptedWorker.answers.set("snapshot", () => { owner.assertIdle(); return SNAPSHOT; });
  ScriptedWorker.answers.set("auto-save-configure", () => undefined);
  ScriptedWorker.answers.set("agent-write-file", () => { owner.assertWorkspaceWritable(); return undefined; });
}

describe("handing a VM's workspace to another tab", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("saves a running VM, stops it and reports that it moved away", async () => {
    ScriptedWorker.answers.set("snapshot", () => SNAPSHOT);
    const vm = await bootedManagedVm();
    const moved = allow(vm);

    const otherTab = askFor("restore");
    await settle();
    otherTab.close();

    expect(otherTab.heard).toEqual([{ version: WORKSPACE_HANDOFF_VERSION, type: "handoff-accepted", requestId: REQUEST_ID }]);
    const control = ScriptedWorker.named("oxidevm-control");
    const saves = control.inputs.filter((input) => input["type"] === "snapshot");
    expect(saves).toHaveLength(1);
    expect(saves[0]).not.toHaveProperty("label");
    expect(saves[0]).not.toHaveProperty("kind");
    // The files go out first, so the save records them and the other tab's resume takes in nothing
    // this guest already holds; disposal then does not write them again.
    expect(control.operations.filter((operation) => operation === "agent-sync-workspace")).toHaveLength(1);
    expect(control.operations.indexOf("agent-sync-workspace")).toBeLessThan(control.operations.indexOf("snapshot"));
    expect(control.operations.indexOf("snapshot")).toBeLessThan(control.operations.indexOf("dispose"));
    expect(ScriptedWorker.named("oxidevm-storage").operations).toContain("dispose");
    expect(moved).toEqual([{ saved: true }]);
  });

  it("moves a VM that runs nothing away without saving", async () => {
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "idle", memoryMiB: 256, vcpus: 1, network: "local" });
    const moved = allow(vm);

    const otherTab = askFor("idle");
    await settle();
    otherTab.close();

    expect(ScriptedWorker.named("oxidevm-control").operations).not.toContain("snapshot");
    expect(ScriptedWorker.named("oxidevm-control").operations).toContain("dispose");
    expect(moved).toEqual([{ saved: false }]);
  });

  it("keeps the running VM when saving fails, reports the typed failure and permits retry", async () => {
    ScriptedWorker.answers.set("auto-save-configure", () => undefined);
    ScriptedWorker.answers.set("snapshot", () => {
      throw new VMError("QUOTA_EXCEEDED", "the browser has no room");
    });
    const vm = await bootedManagedVm();
    const moved = allow(vm);

    const otherTab = askFor("restore");
    await settle();
    otherTab.close();

    const control = ScriptedWorker.named("oxidevm-control");
    expect(control.operations).not.toContain("dispose");
    expect(ScriptedWorker.named("oxidevm-storage").operations).not.toContain("dispose");
    expect(moved).toEqual([]);
    expect(otherTab.heard).toEqual([
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-accepted", requestId: REQUEST_ID },
      { version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId: REQUEST_ID,
        error: { code: "QUOTA_EXCEEDED", message: "the browser has no room" } },
    ]);
    expect(control.inputs).toContainEqual(expect.objectContaining({ type: "auto-save-configure", enabled: true }));

    ScriptedWorker.answers.set("snapshot", () => SNAPSHOT);
    const retry = askFor("restore");
    await settle();
    retry.close();
    expect(control.operations).toContain("dispose");
    expect(moved).toEqual([{ saved: true }]);
  });

  it.each(["agent-sync-workspace", "snapshot"])("keeps real assistance admission writable and spawnable after %s fails", async operation => {
    const vm = await bootedManagedVm();
    const owner = assistanceOwner();
    useAssistanceOwner(owner);
    ScriptedWorker.answers.set(operation, () => { owner.assertIdle(); throw new VMError("STORAGE_ERROR", "save preparation failed"); });
    const moved = allow(vm);
    const spawnedPorts: MessagePort[] = [];
    ScriptedWorker.answers.set("agent-spawn", input => {
      owner.assertWorkspaceWritable();
      const port = input["port"];
      if (!(port instanceof MessagePort)) throw new Error("missing process port");
      spawnedPorts.push(port);
      return { pid: 7 + spawnedPorts.length, sessionId: spawnedPorts.length };
    });
    const original = await vm.spawn({ command: "sh" });
    const release = await holdWorkspace("restore");
    let exited = false;
    void original.exit.then(() => { exited = true; }, () => { exited = true; });
    try {
      await expect(requestWorkspaceHandoff("restore")).rejects.toMatchObject({ code: "STORAGE_ERROR", message: "save preparation failed" });
      expect(moved).toEqual([]);
      expect(ScriptedWorker.named("oxidevm-control").operations).not.toContain("assistance-dispose");
      expect(ScriptedWorker.named("oxidevm-control").inputs).toContainEqual(expect.objectContaining({ type: "auto-save-configure", enabled: true }));
      const free = await navigator.locks.request(workspaceLockName("restore"), { ifAvailable: true }, lock => lock !== null);
      expect(free).toBe(false);
      expect(exited).toBe(false);
      await expect(vm.workspace.writeFile("still-running.txt", new Uint8Array([1]))).resolves.toBeUndefined();
      const second = await vm.spawn({ command: "sh" });
      void second.exit.catch(() => undefined);
      expect(spawnedPorts).toHaveLength(2);
      owner.assertWorkspaceWritable();
      useAssistanceOwner(owner);
      ScriptedWorker.answers.set("dispose", () => { release(); return undefined; });
      await expect(requestWorkspaceHandoff("restore")).resolves.toBe("released");
      await settle();
      expect(moved).toEqual([{ saved: true }]);
    } finally {
      release();
      useAssistanceOwner(owner);
      await vm.dispose();
      for (const port of spawnedPorts) port.close();
      await owner.dispose();
    }
  });

  it("rejects a handoff with a live assisted task without retiring it, then retries after it exits", async () => {
    const vm = await bootedManagedVm();
    const owner = assistanceOwner();
    useAssistanceOwner(owner);
    const broker = new MessageChannel();
    const output = new MessageChannel();
    broker.port2.onmessage = (event: MessageEvent<unknown>) => {
      const command = decodeBrokerCommand(event.data);
      if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: command.identity });
      if (command.kind === "input") broker.port2.postMessage({ kind: "input-ack", identity: command.identity, sequence: command.identity.sequence });
    };
    if (ASSISTANCE_ARTIFACTS === undefined) throw new Error("missing test artifacts");
    owner.attach({ ...owner.prepare(), port: broker.port1, artifacts: ASSISTANCE_ARTIFACTS });
    const process = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    const moved = allow(vm);
    try {
      const otherTab = askFor("restore");
      await settle();
      otherTab.close();
      expect(otherTab.heard).toMatchObject([
        { type: "handoff-accepted" }, { type: "handoff-failed", error: { code: "FEATURE_NOT_AVAILABLE" } },
      ]);
      expect(moved).toEqual([]);
      expect(ScriptedWorker.named("oxidevm-control").operations).not.toContain("assistance-dispose");
      expect(() => owner.assertIdle()).toThrow("Stop assisted tasks");
      await expect(owner.input(process.pid, new Uint8Array([1]))).resolves.toBeUndefined();
      await expect(vm.workspace.writeFile("still-running.txt", new Uint8Array([1]))).resolves.toBeUndefined();
      await owner.stop(process.pid, "KILL");
      const retry = askFor("restore");
      await settle();
      retry.close();
      expect(moved).toEqual([{ saved: true }]);
    } finally {
      await vm.dispose(); await owner.dispose(); broker.port2.close(); output.port2.close();
    }
  });

  it("rejects a reserved bootstrap handoff without cancellation and retries after rollback", async () => {
    const vm = await bootedManagedVm();
    const owner = assistanceOwner(6);
    useAssistanceOwner(owner);
    const prepared = await owner.prepareBound();
    const moved = allow(vm);
    try {
      const otherTab = askFor("restore");
      await settle();
      otherTab.close();
      expect(otherTab.heard).toMatchObject([
        { type: "handoff-accepted" }, { type: "handoff-failed", error: { code: "FEATURE_NOT_AVAILABLE" } },
      ]);
      expect(moved).toEqual([]);
      expect(() => owner.assertIdle()).toThrow("bootstrap");
      const reservation = prepared.credits?.[0]?.reservation;
      if (reservation === undefined) throw new Error("missing reservation");
      owner.releaseBootstrap({ ...prepared, reservation });
      const retry = askFor("restore");
      await settle();
      retry.close();
      expect(moved).toEqual([{ saved: true }]);
    } finally { await vm.dispose(); await owner.dispose(); }
  });

  it("keeps the VM and the save error when restoring autosave also fails", async () => {
    ScriptedWorker.answers.set("snapshot", () => { throw new VMError("QUOTA_EXCEEDED", "save failed"); });
    ScriptedWorker.answers.set("auto-save-configure", () => { throw new VMError("GUEST_CRASH", "autosave failed"); });
    const vm = await bootedManagedVm();
    const moved = allow(vm);
    const otherTab = askFor("restore");
    await settle();
    otherTab.close();
    expect(ScriptedWorker.named("oxidevm-control").operations).not.toContain("dispose");
    expect(moved).toEqual([]);
    expect(otherTab.heard).toContainEqual({
      version: WORKSPACE_HANDOFF_VERSION, type: "handoff-failed", requestId: REQUEST_ID,
      error: { code: "QUOTA_EXCEEDED", message: "save failed", detail: {
        cleanupFailed: true, cleanupError: { code: "GUEST_CRASH", message: "autosave failed" },
      } },
    });
    await vm.dispose();
  });

  it("moves a native VM that has not started without saving", async () => {
    const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" });
    const moved = allow(vm);

    const otherTab = askFor("userspace");
    await settle();
    otherTab.close();

    expect(ScriptedWorker.named("oxidevm-storage").operations).toContain("dispose");
    expect(moved).toEqual([{ saved: false }]);
  });

  it.each([false, true])("keeps a native session after failed handoff and permits retry (cleanup failure: %s)", async cleanupFails => {
    const { bootedNativeVm } = await import("./userspace-vm.test-support.js");
    const vm = await bootedNativeVm();
    const moved = allow(vm);
    ScriptedWorker.answers.set("snapshot", () => { throw new VMError("QUOTA_EXCEEDED", "save failed"); });
    ScriptedWorker.answers.set("auto-save-configure", () => { if (cleanupFails) throw new VMError("GUEST_CRASH", "autosave failed"); return undefined; });
    const first = askFor("userspace"); await settle(); first.close();
    const control = ScriptedWorker.named("oxidevm-control");
    expect(control.operations).toContain("flush-userspace");
    expect(ScriptedWorker.named("oxidevm-storage").operations).not.toContain("dispose");
    expect(moved).toEqual([]);
    expect(first.heard.at(-1)).toMatchObject({ type: "handoff-failed", error: { code: "QUOTA_EXCEEDED", message: "save failed" } });
    ScriptedWorker.answers.set("snapshot", () => SNAPSHOT);
    const retry = askFor("userspace"); await settle(); retry.close();
    expect(moved).toEqual([{ saved: true }]);
    await vm.dispose();
  });

  it("keeps the workspace once the page stops allowing handoffs", async () => {
    const vm = await bootedManagedVm();
    const allowing = new AbortController();
    const moved = allow(vm, allowing.signal);
    allowing.abort();

    const otherTab = askFor("restore");
    await settle();
    otherTab.close();

    expect(otherTab.heard).toEqual([]);
    expect(moved).toEqual([]);
    expect(ScriptedWorker.named("oxidevm-control").operations).not.toContain("dispose");
    await vm.dispose();
  });

  it("does not hand over a workspace while the VM is being disposed", async () => {
    let finishDisposing = (): void => undefined;
    ScriptedWorker.answers.set("assistance-dispose", () => new Promise<undefined>((resolve) => {
      finishDisposing = () => {
        resolve(undefined);
      };
    }));
    const vm = await bootedManagedVm();
    const moved = allow(vm);

    const disposed = vm.dispose();
    const otherTab = askFor("restore");
    await settle();
    finishDisposing();
    await disposed;
    await settle();
    otherTab.close();

    expect(otherTab.heard).toEqual([]);
    expect(moved).toEqual([]);
  });

  it("refuses to allow handoffs without a listener and a signal", async () => {
    const vm = await bootedManagedVm();
    const untyped: { allowWorkspaceHandoff(listener: unknown, options: unknown): void } = vm;

    expect(() => { untyped.allowWorkspaceHandoff(undefined, { signal: new AbortController().signal }); })
      .toThrow(VMError);
    expect(() => { untyped.allowWorkspaceHandoff(() => undefined, {}); }).toThrow(VMError);
    expect(() => { untyped.allowWorkspaceHandoff(() => undefined, { signal: new AbortController().signal, unexpected: true }); })
      .toThrow(VMError);
    await vm.dispose();
  });
});
