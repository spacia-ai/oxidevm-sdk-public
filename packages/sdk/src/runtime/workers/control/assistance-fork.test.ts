import { expect, it, vi } from "vitest";
import { GuestProcessTransport } from "../../guest-process.ts";
import { ASSISTANCE_ARTIFACTS } from "../../assistance-build.js";
import { SystemAssistance } from "./assistance.ts";
import type { AssistanceCredit } from "../../protocol/assistance-credit.ts";
import type { AssistanceRequest } from "../../protocol/assistance.ts";
import type { AssistanceReply } from "../../protocol/assistance-reply.ts";
import type { AssistanceEvent } from "../../protocol/assistance-event.ts";
import { decodeBrokerCommand, decodeBrokerShutdown, type BrokerCommand } from "../../protocol/assistance-broker.ts";

vi.mock("../../assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: {
  version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } }, compiler: { sha256: "0".repeat(64), bytes: 1 }, runtime: { sha256: "0".repeat(64), bytes: 1 },
} }));

const request = { entry: "/workspace/node_modules/next/dist/server/lib/start-server.js", args: ["--port", "3000"], execArgv: ["--enable-source-maps"], cwd: "/workspace", env: { NODE_ENV: "development" }, silent: true };

/** A guest that admits every task, forks helper 40 and reports dependencies. */
function guest(native: AssistanceRequest[], supportsFork = true) {
  return {
    creditAssistance: (_id: number, credit: AssistanceCredit) => Promise.resolve(credit), setInstallationEvents: vi.fn(),
    startInstallation: () => Promise.reject(new Error("unexpected")), installation: () => Promise.reject(new Error("unexpected")),
    supportsAssistance: true, supportsFork, assistanceVersion: 7 as const, checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn<(listener: (event: AssistanceEvent) => void) => void>(), superviseAssistance: vi.fn(async () => {}),
    assistance(_id: number, request: AssistanceRequest): Promise<AssistanceReply> {
      native.push(request);
      const { operation, ...identity } = request;
      if (operation.kind === "start") return Promise.resolve({ ...identity, result: { kind: "started", cwd: operation.cwd, env: operation.env } });
      if (operation.kind === "check-dependencies") return Promise.resolve({ ...identity, result: { kind: "data", bytes: new Uint8Array(64).fill(7) } });
      if (operation.kind === "fork") return Promise.resolve({ ...identity, result: { kind: "spawned", child: 9, pid: 40 + operation.process } });
      return Promise.resolve({ ...identity, result: { kind: "unit" } });
    },
  };
}

/** A broker that reserves, starts (ready) and retires like the real one. */
function brokerFake(port: MessagePort, commands: BrokerCommand[]) {
  const credits = new Map<number, readonly AssistanceCredit[]>();
  port.onmessage = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (typeof value === "object" && value !== null && "kind" in value && value.kind === "shutdown") { port.postMessage({ ...decodeBrokerShutdown(value), kind: "stopped" }); return; }
    const command = decodeBrokerCommand(value);
    commands.push(command);
    if (command.kind === "reserve") credits.set(command.identity.process, command.credits);
    if (command.kind === "start") port.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
    if (command.kind === "stop") port.postMessage({ kind: "retired", identity: command.identity, credits: (credits.get(command.identity.process) ?? []).map(credit => ({ ...credit, kind: "return" })) });
  };
  port.start();
}

async function forkedParent(supportsFork = true) {
  const native: AssistanceRequest[] = [];
  const commands: BrokerCommand[] = [];
  const agent = guest(native, supportsFork);
  const owner = new SystemAssistance(agent);
  const broker = new MessageChannel(); const output = new MessageChannel();
  brokerFake(broker.port2, commands);
  const prepared = await owner.prepareBound();
  if (ASSISTANCE_ARTIFACTS === undefined) throw new Error("missing test artifacts");
  const staging = prepared.credits?.[1];
  owner.attach({ ...owner.prepare(), port: broker.port1, artifacts: ASSISTANCE_ARTIFACTS, ...(staging === undefined ? {} : { receipt: { ...staging, kind: "return" } }) });
  const storage = { readBuildPolicy: vi.fn(() => Promise.resolve([])) };
  const parent = await owner.spawn(1, { entry: "server.cjs", cwd: "/", args: [], env: {}, port: output.port1, workspaceBaseSha256: "a".repeat(64) }, storage);
  const binding = owner.prepare();
  const sequences = new Map<number, number>([[parent.pid, 1]]);
  const next = (process: number) => { const sequence = (sequences.get(process) ?? 0) + 1; sequences.set(process, sequence); return { ...binding, process, sequence }; };
  return { owner, broker, output, native, commands, parent, binding, next, agent, dispose: async () => { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); } };
}

it("consumes the fork helper's exit from the parent's native child stream instead of forwarding it to the parent worker", async () => {
  const fixture = await forkedParent();
  const { owner, broker, commands, parent, binding, next, agent } = fixture;
  try {
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 2)).toBe(true), { timeout: 2000 });
    const listener = agent.setAssistanceEvents.mock.calls.at(-1)?.[0];
    if (listener === undefined) throw new Error("missing guest event listener");
    const forwarded = () => commands.filter(command => command.kind === "event" && command.identity.process === parent.pid).length;
    const before = forwarded();
    // The helper (guest child handle 9) exits cleanly once the child stops. Its
    // exit belongs to control, never to the parent's application child table.
    listener({ session: binding.session, generation: binding.generation, process: parent.pid, sequence: 1, event: { kind: "exit", child: 9, code: 0, signal: null } });
    // An ordinary native child of the parent still reaches its worker.
    listener({ session: binding.session, generation: binding.generation, process: parent.pid, sequence: 2, event: { kind: "exit", child: 3, code: 0, signal: null } });
    await vi.waitFor(() => expect(forwarded()).toBe(before + 1));
    expect(commands.filter(command => command.kind === "event" && command.identity.process === parent.pid).at(-1)).toMatchObject({ identity: { process: parent.pid } });
    expect(owner.rejectedRetiredEvents).toBe(0);
    expect(owner.consumedHelperExits).toBe(1);
    // A second fork's helper (handle 9 again after the first retired) may only exit; output from it is a guest protocol violation.
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 3)).toBe(true), { timeout: 2000 });
    listener({ session: binding.session, generation: binding.generation, process: parent.pid, sequence: 3, event: { kind: "eof", child: 9, stream: "stdout" } });
    await expect(owner.dispose()).rejects.toThrow(/helper/u);
  } finally { await fixture.dispose(); }
});

it("forks through the parent's mailbox: reserves the child, issues the guest Fork, replies before the worker starts and inherits dependencies", async () => {
  const fixture = await forkedParent();
  const { owner, broker, native, commands, parent, next } = fixture;
  try {
    const before = commands.length;
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.slice(before).map(command => command.kind)).toEqual(["reserve", "fork-reply", "start"]), { timeout: 2000 });
    const [reserve, reply, start] = commands.slice(before);
    expect(reserve).toMatchObject({ kind: "reserve", identity: { process: 2, sequence: 1 } });
    expect(reply).toEqual({ kind: "fork-reply", identity: { ...next(0), process: parent.pid, sequence: 2 }, reply: { kind: "spawned", process: 2, pid: 42 } });
    const fork = native.find(request => request.operation.kind === "fork");
    expect(fork).toMatchObject({ process: parent.pid, operation: { kind: "fork", process: 2, dependencies: new Uint8Array(64).fill(7) } });
    expect(native.filter(request => request.operation.kind === "start").at(-1)).toMatchObject({ process: 2, operation: { cwd: "/workspace", env: request.env } });
    expect(start).toMatchObject({ kind: "start", identity: { process: 2 }, entry: request.entry, args: request.args, cwd: "/workspace", parent: parent.pid, silent: true, execArgv: request.execArgv,
      dependencies: { generation: "07".repeat(32), inputsSha256: "07".repeat(32) } });
    // The child is an ordinary task for VM state purposes.
    expect(() => owner.assertIdle()).toThrow();
    await owner.stop(2, "KILL");
    expect(native.at(-1)).toMatchObject({ process: 2, operation: { kind: "stop" } });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "fork-exit", identity: { process: parent.pid }, child: 2, termination: { kind: "signal", signal: 9 } }));
  } finally { await fixture.dispose(); }
});

it("routes silent child output to the parent worker with acknowledgements and joins inherited output to the parent's stream", async () => {
  const fixture = await forkedParent();
  const { owner, broker, output, commands, parent, binding, next } = fixture;
  try {
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 2)).toBe(true), { timeout: 2000 });
    const child = { ...binding, process: 2, sequence: 2 };
    broker.port2.postMessage({ kind: "output", identity: child, stream: "stderr", bytes: Uint8Array.of(65) });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "fork-output", identity: { process: parent.pid }, child: 2, stream: "stderr", chunk: 1 }));
    const forwarded = commands.at(-1);
    if (forwarded?.kind !== "fork-output") throw new Error("missing forwarded output");
    expect(forwarded.bytes).toEqual(Uint8Array.of(65));
    expect(commands.some(command => command.kind === "reply" && command.identity.process === 2 && command.identity.sequence === 2)).toBe(false);
    broker.port2.postMessage({ kind: "fork-output-ack", identity: next(parent.pid), child: 2, chunk: 1 });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "reply", identity: { process: 2, sequence: 2 } }));
    // A second, inherited child shares the parent's public stdout in order.
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request: { ...request, silent: false } });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 3)).toBe(true), { timeout: 2000 });
    const transport = new GuestProcessTransport(output.port2, parent.pid, parent.sessionId, {
      write: () => Promise.reject(new Error("unused")), closeStdin: () => Promise.resolve(), signal: signal => owner.stop(parent.pid, signal),
    });
    const reader = transport.stdout.getReader();
    broker.port2.postMessage({ kind: "output", identity: { ...binding, process: 3, sequence: 2 }, stream: "stdout", bytes: Uint8Array.of(66) });
    broker.port2.postMessage({ kind: "output", identity: { ...binding, process: parent.pid, sequence: 5 }, stream: "stdout", bytes: Uint8Array.of(67) });
    expect(await reader.read()).toEqual({ done: false, value: Uint8Array.of(66) });
    expect(await reader.read()).toEqual({ done: false, value: Uint8Array.of(67) });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "reply" && command.identity.process === 3 && command.identity.sequence === 2)).toBe(true));
    reader.releaseLock();
  } finally { await fixture.dispose(); }
});

it("delivers parent input and catchable signals to the child, retires it on KILL and on its own signal exit, and retires children before the parent", async () => {
  const fixture = await forkedParent();
  const { owner, broker, native, commands, parent, binding, next } = fixture;
  try {
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 2)).toBe(true), { timeout: 2000 });
    const input = next(parent.pid);
    broker.port2.postMessage({ kind: "fork-input", identity: input, child: 2, bytes: Uint8Array.of(1) });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "input", identity: { process: 2 } }));
    const forwarded = commands.at(-1);
    if (forwarded?.kind !== "input") throw new Error("missing child input");
    broker.port2.postMessage({ kind: "input-ack", identity: { ...binding, process: 2, sequence: 2 }, sequence: forwarded.identity.sequence });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "reply", identity: input }));
    const term = next(parent.pid);
    broker.port2.postMessage({ kind: "fork-signal", identity: term, child: 2, signal: "TERM" });
    await vi.waitFor(() => {
      const signals = commands.filter(command => command.kind === "signal");
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ kind: "signal", identity: { process: 2 }, signal: "TERM" });
    });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "reply" && command.identity.sequence === term.sequence && command.identity.process === parent.pid)).toBe(true));
    broker.port2.postMessage({ kind: "exit-signal", identity: { ...binding, process: 2, sequence: 3 }, signal: 15 });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "fork-exit", child: 2, termination: { kind: "signal", signal: 15 } }));
    expect(native.filter(request => request.process === 2).at(-1)?.operation).toEqual({ kind: "stop" });
    // A second child is killed by the parent, then the parent's stop retires a third child first.
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 3)).toBe(true), { timeout: 2000 });
    broker.port2.postMessage({ kind: "fork-signal", identity: next(parent.pid), child: 3, signal: "KILL" });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "fork-exit", child: 3, termination: { kind: "signal", signal: 9 } }));
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 4)).toBe(true), { timeout: 2000 });
    const stops = native.length;
    await owner.stop(parent.pid, "KILL");
    expect(native.slice(stops).filter(request => request.operation.kind === "stop").map(request => request.process)).toEqual([4, parent.pid]);
    owner.assertIdle();
  } finally { await fixture.dispose(); }
});

it("ignores a parent's late output acknowledgement for a child that already retired", async () => {
  const fixture = await forkedParent();
  const { owner, broker, commands, parent, binding, next } = fixture;
  try {
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === 2)).toBe(true), { timeout: 2000 });
    broker.port2.postMessage({ kind: "output", identity: { ...binding, process: 2, sequence: 2 }, stream: "stdout", bytes: Uint8Array.of(65) });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "fork-output", child: 2, chunk: 1 }));
    broker.port2.postMessage({ kind: "exit", identity: { ...binding, process: 2, sequence: 3 }, code: 0 });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "fork-exit", child: 2, termination: { kind: "exit", code: 0 } }));
    broker.port2.postMessage({ kind: "fork-output-ack", identity: next(parent.pid), child: 2, chunk: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(() => owner.assertHealthy()).not.toThrow();
    await owner.stop(parent.pid, "KILL");
    owner.assertIdle();
  } finally { await fixture.dispose(); }
});

it("refuses forks without the guest capability and at process capacity with Node errno codes", async () => {
  const unsupported = await forkedParent(false);
  try {
    unsupported.broker.port2.postMessage({ kind: "fork", identity: unsupported.next(unsupported.parent.pid), request });
    await vi.waitFor(() => expect(unsupported.commands.at(-1)).toMatchObject({ kind: "fork-reply", reply: { kind: "error", errno: 38, code: "ENOSYS" } }));
  } finally { await unsupported.dispose(); }
  const fixture = await forkedParent();
  const { broker, commands, parent, next } = fixture;
  try {
    for (const child of [2, 3, 4]) {
      broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
      await vi.waitFor(() => expect(commands.some(command => command.kind === "start" && command.identity.process === child)).toBe(true), { timeout: 2000 });
    }
    broker.port2.postMessage({ kind: "fork", identity: next(parent.pid), request });
    await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ kind: "fork-reply", reply: { kind: "error", errno: 11, code: "EAGAIN" } }));
  } finally { await fixture.dispose(); }
});
