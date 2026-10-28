import { expect, it, vi } from "vitest";
import { GuestAgent } from "./guest-agent.js";
import { AgentFrameDecoder, AgentKind, AgentPayloadWriter, encodeAgentFrame, type AgentFrame } from "../../agent-protocol.js";
import { decodeWorkspaceRestore, type WorkspaceRestore } from "../../protocol/workspace-restore.js";
import { CORE_API_VERSION, createCore } from "./core.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { JIT_API_VERSION } from "../../core-abi/jit.js";

async function fixture(failure?: "commit" | "abort", dependencies: "current" | "receive" = "receive", capabilities = 3) {
  const memory = new WebAssembly.Memory({ initial: 3 });
  const queued: Uint8Array[] = [];
  const input = new AgentFrameDecoder();
  const operations: WorkspaceRestore[] = [];
  const requestIds: number[] = [];
  const failed = vi.fn();
  function enqueue(frame: AgentFrame): void {
    const bytes = encodeAgentFrame({ ...frame, requestId: frame.requestId || 1 });
    new DataView(bytes.buffer).setUint32(8, frame.requestId, true);
    queued.push(bytes);
  }
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_system_agent_input: (length: number) => {
      for (const frame of input.push(new Uint8Array(memory.buffer, 0, length))) {
        let status = 0;
        if (frame.kind === AgentKind.workspaceRestore) {
          const operation = decodeWorkspaceRestore(frame.payload, frame.version);
          operations.push(operation);
          requestIds.push(frame.requestId);
          if (operation.kind === failure) status = 4;
        }
        enqueue({ version: 7, kind: frame.kind | 0x8000, requestId: frame.requestId, status,
          payload: frame.kind === AgentKind.hello
            ? new AgentPayloadWriter().string("restore-stream-test").u32(capabilities).finish()
            : status !== 0 ? new TextEncoder().encode("workspace restore outcome uncertain")
            : frame.kind === AgentKind.workspaceRestore && operations.at(-1)?.kind === "status" ? Uint8Array.of(1, ...new Uint8Array(16))
            : frame.kind === AgentKind.workspaceRestore && operations.at(-1)?.kind === "begin-dependencies" ? Uint8Array.of(dependencies === "current" ? 1 : 0)
            : new Uint8Array(),
        });
      }
      return length;
    },
    oxidevm_system_agent_output: () => {
      const bytes = queued.shift();
      if (bytes === undefined) return 0;
      new Uint8Array(memory.buffer).set(bytes);
      return bytes.length;
    },
  };
  const core = createCore(new Proxy(functions, { get(target, key) {
    if (typeof key === "string" && key in target) return target[key];
    return () => { throw new Error(`Unexpected core call ${String(key)}`); };
  } }), memory, "restore-stream-test", JIT_CACHE_BYTES);
  const agent = new GuestAgent(() => { agent.drainOutput(core); return Promise.resolve(undefined); },
    () => {}, () => undefined, () => "", () => ({ active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" as const }), failed);
  agent.activate(core);
  enqueue({ version: 7, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
  await agent.wait(1, 1000);
  return { agent, operations, requestIds, failed };
}

it.each(["snapshot", "delta"] as const)("fences streamed %s timestamps on old guest integration, including fragmented headers", async format => {
  const { agent, operations, failed } = await fixture();
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode(format === "snapshot" ? "OXRF" : "OXWD"));
  new DataView(bytes.buffer).setUint16(4, format === "snapshot" ? 8 : 3, true);
  const retire = vi.fn(async () => {});
  await expect(agent.applyWorkspaceStream(6, format, { bytes: bytes.length, source: () => ({ retire,
    frames: (async function* () { for (const byte of bytes) yield await Promise.resolve(Uint8Array.of(byte)); })(),
  }) })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" } });
  expect(operations[0]?.kind).toBe("begin");
  expect(operations.at(-1)?.kind).toBe("abort");
  expect(operations.some(operation => operation.kind === "commit")).toBe(false);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
  expect(() => agent.assertWorkspaceHealthy()).not.toThrow();
});

it("commits timestamp records only after the guest advertises their native capability", async () => {
  const { agent, operations } = await fixture(undefined, "receive", 1027);
  const bytes = Uint8Array.of(79, 88, 82, 70, 8, 0, 0, 0, 0, 0, 0, 0);
  await agent.applyWorkspaceStream(7, "snapshot", { bytes: bytes.length, source: () => ({
    retire: async () => {}, frames: (async function* () { yield await Promise.resolve(bytes); })(),
  }) });
  expect(operations.map(operation => operation.kind)).toEqual(["begin", "chunk", "commit", "status"]);
});

it("connects storage stream receipt to framed guest v7 with existing correlation identities", async () => {
  const { agent, operations, requestIds, failed } = await fixture();
  const retired = Promise.withResolvers<undefined>();
  const retire = vi.fn(() => retired.promise);
  const bytes = new Uint8Array(65_549).fill(42);
  const done = agent.applyWorkspaceStream(2, "snapshot", { bytes: bytes.length,
    source: () => ({ retire, frames: (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 65_536) yield await Promise.resolve(bytes.slice(offset, offset + 65_536));
    })() }) });
  await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(1));
  expect(operations.map(operation => operation.kind)).toEqual(["begin", "chunk", "chunk"]);
  expect(operations[0]?.transfer).toBe(requestIds[0]);
  expect(new Set(operations.map(operation => operation.transfer)).size).toBe(1);
  retired.resolve(undefined);
  await done;
  expect(operations.slice(-2).map(operation => operation.kind)).toEqual(["commit", "status"]);
  expect(failed).not.toHaveBeenCalled();
  expect(() => agent.assertWorkspaceHealthy()).not.toThrow();
});

it("sends and confirms native abort when cancelled during storage reads", async () => {
  const { agent, operations, failed } = await fixture();
  const reading = Promise.withResolvers<undefined>();
  const retire = vi.fn(async () => {});
  const done = agent.applyWorkspaceStream(3, "delta", { bytes: 12, source: signal => ({ retire,
    frames: (async function* () {
      reading.resolve(undefined);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield await Promise.resolve(new Uint8Array(12));
    })(),
  }) });
  const rejected = expect(done).rejects.toMatchObject({ code: "ABORTED" });
  await reading.promise;
  agent.cancel(3);
  await rejected;
  expect(operations.map(operation => operation.kind)).toEqual(["begin", "abort"]);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});

it.each(["commit", "abort"] as const)("uses the existing admission fence after an uncertain guest %s", async failure => {
  const { agent, failed } = await fixture(failure);
  await expect(agent.applyWorkspaceStream(4, "snapshot", { bytes: 12, source: () => ({
    retire: async () => {}, frames: (async function* () {
      if (failure === "abort") throw new Error("storage read failure");
      yield await Promise.resolve(new Uint8Array(12));
    })(),
  }) })).rejects.toMatchObject({ code: "GUEST_CRASH" });
  expect(failed).toHaveBeenCalledTimes(1);
  expect(() => agent.assertWorkspaceHealthy()).toThrow("reopen");
});

it.each(["current", "receive"] as const)("reopens dependencies without streaming when the guest reports its generation %s", async outcome => {
  const { agent, operations, failed } = await fixture(undefined, outcome);
  const retire = vi.fn(async () => {});
  const target = { kind: "dependencies", generation: new Uint8Array(32).fill(1), inputs: new Uint8Array(32).fill(2) } as const;
  await agent.applyWorkspaceStream(4, target, { bytes: 12, source: () => ({ retire,
    frames: (async function* () { yield await Promise.resolve(new Uint8Array(12).fill(9)); })() }) });
  expect(operations.map(operation => operation.kind)).toEqual(outcome === "current" ? ["begin-dependencies"] : ["begin-dependencies", "chunk", "commit", "status"]);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
  expect(() => agent.assertWorkspaceHealthy()).not.toThrow();
});
