// A guest agent whose side of hvc1 is scripted, for tests of GuestAgent's owners: the host's
// requests are decoded into `received`, and `answer` decides what the guest sends back.
import { AgentFragmentSender } from "../../agent-fragments.js";
import {
  AGENT_RESPONSE_BIT,
  AgentFrameDecoder,
  AgentKind,
  AgentPayloadWriter,
  encodeAgentFrame,
  type AgentFrame,
  type AgentProtocolVersion,
} from "../../agent-protocol.js";
import { JIT_API_VERSION } from "../../core-abi/jit.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { CORE_API_VERSION, createCore, type Core } from "./core.js";
import { GuestAgent } from "./guest-agent.js";

export interface ScriptedGuestOptions {
  readonly version: AgentProtocolVersion;
  readonly capabilities: number;
  /** What the guest sends for a request: by default its HELLO reply, and an empty reply otherwise. */
  readonly answer?: (request: AgentFrame) => readonly AgentFrame[];
  /** Whether the agent announces itself at once (false for a guest restored mid-session). */
  readonly ready?: boolean;
}

export interface ScriptedGuest {
  readonly agent: GuestAgent;
  readonly core: Core;
  /** The host's requests, in order. */
  readonly received: AgentFrame[];
  /** Whether a running session drains the agent; requests pump it themselves while false. */
  readonly session: { active: boolean };
  /** Queues a frame the guest sends. */
  send(frame: AgentFrame): void;
  /** One drain of the agent's output, as a running session's step does. */
  drain(): void;
}

export function helloReply(request: AgentFrame, capabilities: number): AgentFrame {
  return {
    version: request.version, kind: AgentKind.hello | AGENT_RESPONSE_BIT, requestId: request.requestId, status: 0,
    payload: new AgentPayloadWriter().string("scripted-guest").u32(capabilities).finish(),
  };
}

export function emptyReply(request: AgentFrame): AgentFrame {
  return { version: request.version, kind: request.kind | AGENT_RESPONSE_BIT, requestId: request.requestId, status: 0, payload: new Uint8Array() };
}

export function scriptedGuest(options: ScriptedGuestOptions): ScriptedGuest {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const outbound: Uint8Array[] = [];
  const fragments = new AgentFragmentSender();
  const inbound = new AgentFrameDecoder();
  const received: AgentFrame[] = [];
  const session = { active: false };
  const answer = options.answer
    ?? ((request: AgentFrame) => [request.kind === AgentKind.hello ? helloReply(request, options.capabilities) : emptyReply(request)]);
  function send(frame: AgentFrame): void {
    for (const part of fragments.frames(frame)) {
      const bytes = encodeAgentFrame({ ...part, requestId: part.requestId || 1 });
      new DataView(bytes.buffer).setUint32(8, part.requestId, true);
      outbound.push(bytes);
    }
  }
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_system_agent_input: (length: number) => {
      for (const request of inbound.push(new Uint8Array(memory.buffer, 0, length).slice())) {
        received.push(request);
        for (const reply of answer(request)) send(reply);
      }
      return length;
    },
    oxidevm_system_agent_output: () => {
      const bytes = outbound.shift();
      if (bytes === undefined) return 0;
      new Uint8Array(memory.buffer).set(bytes);
      return bytes.length;
    },
  };
  const core = createCore(new Proxy(functions, {
    get(target, key) {
      if (typeof key === "string" && key in target) return target[key];
      return () => { throw new Error(`Unexpected core call ${String(key)}`); };
    },
  }), memory, "scripted-guest", JIT_CACHE_BYTES);
  const agent: GuestAgent = new GuestAgent(
    () => {
      agent.drainOutput(core);
      return Promise.resolve(undefined);
    },
    () => {},
    () => undefined,
    () => "",
    () => ({ active: session.active, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" as const }),
    () => {},
  );
  agent.activate(core);
  if (options.ready !== false) send({ version: options.version, kind: AgentKind.ready, requestId: 0, status: 0, payload: new Uint8Array() });
  return { agent, core, received, session, send, drain: () => { agent.drainOutput(core); } };
}
