import { expect, it } from "vitest";
import { AgentFragmentSender } from "../../agent-fragments.js";
import { AgentKind, AgentPayloadWriter, encodeAgentFrame, type AgentFrame } from "../../agent-protocol.js";
import { GuestAgent } from "./guest-agent.js";
import { CORE_API_VERSION, createCore } from "./core.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { JIT_API_VERSION } from "../../core-abi/jit.js";

/** A guest whose hello advertises `capabilities`, answered on the existing pump. */
function guest(version: 6 | 7, capabilities: number): GuestAgent {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const queued: Uint8Array[] = [];
  const fragments = new AgentFragmentSender();
  function enqueue(frame: AgentFrame): void {
    for (const part of fragments.frames(frame)) {
      const bytes = encodeAgentFrame({ ...part, requestId: part.requestId || 1 });
      new DataView(bytes.buffer).setUint32(8, part.requestId, true);
      queued.push(bytes);
    }
  }
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_system_agent_input: (length: number) => {
      const view = new DataView(memory.buffer);
      enqueue({ version, kind: view.getUint16(6, true) | 0x8000, requestId: view.getUint32(8, true), status: 0,
        payload: new AgentPayloadWriter().string("capability-test").u32(capabilities).finish() });
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
  } }), memory, "fork-capability-test", JIT_CACHE_BYTES);
  const agent = new GuestAgent(() => { agent.drainOutput(core); return Promise.resolve(undefined); }, () => {}, () => undefined, () => "", () => ({ active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" as const }), () => {});
  agent.activate(core);
  enqueue({ version, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
  return agent;
}

it("advertises fork only on guest seven after the agent's boot probe set bit 16", async () => {
  const forked = guest(7, 27);
  await forked.wait(1, 1000);
  expect(forked.supportsAssistance).toBe(true);
  expect(forked.supportsFork).toBe(true);
  const plain = guest(7, 11);
  await plain.wait(1, 1000);
  expect(plain.supportsAssistance).toBe(true);
  expect(plain.supportsFork).toBe(false);
});

it("rejects the fork bit from a guest six agent as an unknown capability", async () => {
  const stale = guest(6, 27);
  await expect(stale.wait(1, 1000)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(stale.supportsFork).toBe(false);
});

it("accepts capability 64 from a guest seven agent and rejects it from guest six", async () => {
  const watching = guest(7, 27 | 64);
  await watching.wait(1, 1000);
  expect(watching.supportsListeners).toBe(true);
  const older = guest(6, 11 | 64);
  await expect(older.wait(1, 1000)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});
it("admits generation-qualified process controls only for guest seven and rejects unknown new bits", async () => {
  await expect(guest(7, 3 | 32 | 64 | 128 | 256).wait(1, 1000)).resolves.toMatchObject({ capabilities: { files: true, processes: true } });
  await expect(guest(6, 3 | 256).wait(1, 1000)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(guest(7, 3 | 512).wait(1, 1000)).resolves.toMatchObject({ capabilities: { files: true, processes: true } });
  await expect(guest(6, 3 | 512).wait(1, 1000)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(guest(7, 3 | 1024).wait(1, 1000)).resolves.toMatchObject({ capabilities: { files: true, processes: true } });
  await expect(guest(6, 3 | 1024).wait(1, 1000)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  for (const capability of [2048, 4096]) {
    await expect(guest(7, 3 | capability).wait(1, 1000)).resolves.toMatchObject({ capabilities: { files: true, processes: true } });
    await expect(guest(6, 3 | capability).wait(1, 1000)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  }
  await expect(guest(7, 3 | 16384).wait(1, 1000)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});

it("finds no listener watching in today's guest seven agent (capabilities 59)", async () => {
  const today = guest(7, 59);
  await today.wait(1, 1000);
  expect(today.supportsListeners).toBe(false);
});
