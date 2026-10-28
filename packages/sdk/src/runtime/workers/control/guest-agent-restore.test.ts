import { expect, it, vi } from "vitest";
import { VMError } from "../../errors.js";
import { GuestAgent } from "./guest-agent.js";
import { AgentKind, AgentPayloadWriter, encodeAgentFrame, type AgentFrame } from "../../agent-protocol.js";
import { CORE_API_VERSION, createCore } from "./core.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { JIT_API_VERSION } from "../../core-abi/jit.js";

it.each(["snapshot", "delta"] as const)("fences guest admission after failed %s restoration", async kind => {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const queued: Uint8Array[] = [];
  const requests: number[] = [];
  let restoreStatus = 0;
  let canceled = false;
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
      const view = new DataView(memory.buffer);
      const operation = view.getUint16(6, true);
      requests.push(operation);
      enqueue({ version: 6, kind: operation | 0x8000, requestId: view.getUint32(8, true),
        status: operation === AgentKind.hello ? 0 : restoreStatus,
        payload: operation === AgentKind.hello
          ? new AgentPayloadWriter().string("restore-test").u32(11).finish()
          : restoreStatus === 0 ? new Uint8Array() : new TextEncoder().encode("workspace rollback failed"),
      });
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
  } }), memory, "restore-failure-test", JIT_CACHE_BYTES);
  const failed = vi.fn();
  const agent = new GuestAgent(() => { agent.drainOutput(core); return Promise.resolve(undefined); },
    () => { if (canceled) throw new VMError("ABORTED", "canceled before dispatch"); },
    () => undefined, () => "", () => ({ active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" as const }), failed);
  agent.activate(core);
  enqueue({ version: 6, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
  await agent.wait(1, 1000);
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode(kind === "snapshot" ? "OXRF" : "OXWD"));
  bytes[4] = kind === "snapshot" ? 5 : 1;
  const restore = () => kind === "snapshot" ? agent.applyWorkspace(2, bytes) : agent.applyWorkspaceDelta(2, bytes);
  canceled = true;
  const initialRequests = requests.length;
  await expect(restore()).rejects.toMatchObject({ code: "ABORTED" });
  expect(requests).toHaveLength(initialRequests);
  expect(failed).not.toHaveBeenCalled();
  canceled = false;
  await restore();
  expect(() => agent.assertWorkspaceHealthy()).not.toThrow();
  expect(failed).not.toHaveBeenCalled();
  restoreStatus = 4;
  const restored = Promise.all([restore(), restore()]);
  await expect(restored).rejects.toMatchObject({ code: "GUEST_CRASH" });
  expect(failed).toHaveBeenCalledTimes(1);
  const before = requests.length;
  await expect(agent.workspaceManifest(3)).rejects.toMatchObject({ code: "GUEST_CRASH" });
  expect(requests).toHaveLength(before);
  agent.reset();
  expect(() => agent.assertWorkspaceHealthy()).toThrow("reopen");
});
