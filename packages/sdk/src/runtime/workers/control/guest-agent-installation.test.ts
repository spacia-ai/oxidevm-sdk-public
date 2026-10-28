import { expect, it, vi } from "vitest";
import { GuestAgent } from "./guest-agent.js";
import type { InstallationRequest } from "../../protocol/assistance-installation.js";

it("rejects installation I/O without an admitted live guest before driving execution", async () => {
  const pump = vi.fn(() => Promise.resolve(undefined));
  const request: InstallationRequest = {
    session: "11111111-2222-4333-8444-555555555555", generation: 1,
    installation: 1, sequence: 1, operation: { kind: "stop" },
  };
  for (const active of [false, true]) {
    const agent = new GuestAgent(pump, () => {}, () => undefined, () => "", () => ({ active, paused: false, stopping: false, awaitingConsoleAck: false, waiting: active ? "run" as const : "none" as const }), () => {});
    await expect(agent.installation(1, request)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  }
  expect(pump).not.toHaveBeenCalled();
});

import { AgentFragmentSender } from "../../agent-fragments.js";
import { AgentKind, AgentPayloadWriter, encodeAgentFrame, type AgentFrame } from "../../agent-protocol.js";
import { CORE_API_VERSION, createCore } from "./core.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { JIT_API_VERSION } from "../../core-abi/jit.js";
import { encodeInstallationEvent, type InstallationEvent } from "../../protocol/assistance-installation-event.js";

it.each([6, 7] as const)("v%s drains installation events on the existing pump and rejects stale identities and sequences", async version => {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const queued: Uint8Array[] = [];
  const fragments = new AgentFragmentSender();
  let requests = 0;
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
      requests += 1;
      const view = new DataView(memory.buffer);
      enqueue({ version, kind: view.getUint16(6, true) | 0x8000,
        requestId: view.getUint32(8, true), status: 0,
        payload: new AgentPayloadWriter().string("installation-test").u32(11).finish() });
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
  } }), memory, "installation-event-test", JIT_CACHE_BYTES);
  let active = false;
  const agent = new GuestAgent(() => { agent.drainOutput(core); return Promise.resolve(undefined); }, () => {}, () => undefined, () => "", () => ({ active, paused: false, stopping: false, awaitingConsoleAck: false, waiting: active ? "run" as const : "none" as const }), () => {});
  agent.activate(core);
  enqueue({ version, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
  await agent.wait(1, 1000);
  expect(agent.supportsAssistance).toBe(true);
  expect(agent.assistanceVersion).toBe(version);
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 7 };
  const receive = vi.fn();
  expect(() => agent.setInstallationEvents(binding, receive)).toThrow();
  active = true;
  if (version === 6) {
    const before = requests;
    for (const operation of [{ kind: "watch-add", path: "/workspace" }, { kind: "watch-remove", watch: 1 }, { kind: "watch-read" }] as const) {
      await expect(agent.assistance(2, { session: binding.session, generation: 1, process: 1, sequence: 1, operation })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    }
    expect(requests).toBe(before);
  }
  agent.setInstallationEvents(binding, receive);
  expect(() => agent.setInstallationEvents(binding, receive)).toThrow();
  const event: InstallationEvent = { ...binding, sequence: 1, event: { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array(65536) } };
  function send(value: InstallationEvent): void {
    enqueue({ version, kind: AgentKind.installationEvent, requestId: 0, status: 0, payload: encodeInstallationEvent(value, version) });
    agent.drainOutput(core);
  }
  send(event);
  expect(receive).toHaveBeenCalledExactlyOnceWith(event);
  expect(() => send(event)).toThrow("installation event");
  expect(() => send({ ...event, sequence: 2, installation: 8 })).toThrow("installation event");
  expect(() => send({ ...event, sequence: 2, generation: 2 })).toThrow("installation event");
  send({ ...event, sequence: 2 });
  expect(receive).toHaveBeenCalledTimes(2);
  agent.setInstallationEvents(undefined);
  // A pending ordinary response makes the pump observe an unsolicited event.
  agent.setAssistanceEvents(() => {});
  expect(() => send({ ...event, sequence: 3 })).toThrow("installation event");
});

it("a retire request the guest never answers fails at the supervisory deadline instead of hanging", async () => {
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
  let unanswered = 0;
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_system_agent_input: (length: number) => {
      const view = new DataView(memory.buffer);
      const kind = view.getUint16(6, true);
      // The guest takes the installation request and never replies.
      if (kind === AgentKind.installationIo) { unanswered += 1; return length; }
      enqueue({ version: 7, kind: kind | 0x8000, requestId: view.getUint32(8, true), status: 0,
        payload: new AgentPayloadWriter().string("installation-test").u32(11).finish() });
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
  } }), memory, "installation-retire-deadline", JIT_CACHE_BYTES);
  let active = false;
  const agent = new GuestAgent(() => { agent.drainOutput(core); return Promise.resolve(undefined); }, () => {}, () => undefined, () => "", () => ({ active, paused: false, stopping: false, awaitingConsoleAck: false, waiting: active ? "run" as const : "none" as const }), () => {});
  agent.activate(core);
  enqueue({ version: 7, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
  await agent.wait(1, 1000);
  active = true;
  vi.useFakeTimers();
  try {
    const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 7 };
    const retire = agent.installation(0, { ...identity, sequence: 9, operation: { kind: "retire" } });
    let settled = false;
    const outcome = retire.then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(unanswered).toBe(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(await outcome).toMatchObject({ code: "GUEST_CRASH", message: "guest agent response deadline exceeded" });
  } finally { vi.useRealTimers(); }
});
