import { VMError } from "../../errors.ts";
import { AgentKind } from "../../agent-protocol.ts";
import { describe, expect, it, vi } from "vitest";
import { GuestProcessTransport } from "../../guest-process.ts";
import { ASSISTANCE_ARTIFACTS } from "../../assistance-build.js";
import { SystemAssistance } from "./assistance.ts";
import { decodeSystemNetworkMessage } from "../../protocol/system-network.js";
import { SystemNetworkChannel } from "../system-network-channel.js";
import type { AssistancePreparation } from "../../protocol/assistance-control.ts";
import type { AssistanceCredit } from "../../protocol/assistance-credit.ts";
import type { AssistanceVmRequest } from "../../protocol/assistance-vm.ts";
import { ASSISTANCE_LIMITS, type AssistanceRequest } from "../../protocol/assistance.ts";
import { AssistanceTraffic } from "./assistance-traffic.ts";
import type { AssistanceReply } from "../../protocol/assistance-reply.ts";
import { decodeBrokerCommand, decodeBrokerShutdown } from "../../protocol/assistance-broker.ts";
import { decodeAssistanceEvent, type AssistanceEvent } from "../../protocol/assistance-event.ts";

vi.mock("../../assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: {
  version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } }, compiler: { sha256: "0".repeat(64), bytes: 1 }, runtime: { sha256: "0".repeat(64), bytes: 1 },
} }));

it("retires the network generation before rebinding and fences reported worker loss", async () => {
  const agent = { creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6 as const,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    superviseAssistance: vi.fn(async () => {}),
  };
  const owner = new SystemAssistance(agent);
  owner.assertWorkspaceWritable();
  const ports = new MessageChannel();
  const network = new SystemNetworkChannel(ports.port1);
  owner.attachNetwork(ports.port2);
  try {
    const prepared = await owner.prepareBound();
    const first = network.signal;
    expect(first?.aborted).toBe(false);
    releasePrepared(owner, prepared);
    await owner.replaceGeneration();
    expect(first?.aborted).toBe(true);
    const next = await owner.prepareBound();
    expect(next.generation).toBe(prepared.generation + 1);
    expect(network.signal?.aborted).toBe(false);
    owner.networkFailed();
    expect(() => owner.assertWorkspaceWritable()).toThrow();
    await expect(owner.dispose()).rejects.toMatchObject({ code: "RELAY_ERROR" });
    expect(() => owner.prepare()).toThrow();
  } finally { await owner.dispose().catch(() => undefined); network.close(); ports.port2.close(); }
});

it("fences new workspace mutations before disposal begins its final flush", async () => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(),
    startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 7,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(), superviseAssistance: vi.fn(async () => {}),
  });
  owner.assertWorkspaceWritable();
  const closing = owner.dispose();
  expect(() => owner.assertWorkspaceWritable()).toThrow("retiring");
  await closing;
  expect(() => owner.assertWorkspaceWritable()).toThrow("retiring");
});

it.each(["guest", "network"])("blocks VM state changes during pending %s startup", async stage => {
  const bound = Promise.withResolvers<undefined>();
  const ports = new MessageChannel();
  let network: SystemNetworkChannel | undefined;
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    superviseAssistance(_id, request) { return request.operation === "bind" ? bound.promise : Promise.resolve(); },
  });
  owner.attachNetwork(ports.port2);
  const preparing = owner.prepareBound();
  try {
    if (stage === "network") { bound.resolve(undefined); await Promise.resolve(); await Promise.resolve(); }
    expect(() => owner.assertIdle()).toThrow("startup");
    await expect(owner.replaceGeneration()).rejects.toThrow("startup");
  } finally {
    network = new SystemNetworkChannel(ports.port1);
    bound.resolve(undefined);
    releasePrepared(owner, await preparing);
    await owner.dispose(); network.close(); ports.port2.close();
  }
});

it("binds v6 once, supervises idle ownership and fences before rebinding", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const calls: AssistanceVmRequest[] = [];
  const bound = Promise.withResolvers<undefined>();
  const agent = { creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6 as const,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    superviseAssistance(_id: number, request: AssistanceVmRequest): Promise<void> {
      calls.push(request);
      return calls.length === 1 ? bound.promise : Promise.resolve();
    },
  };
  const owner = new SystemAssistance(agent);
  try {
    const first = owner.prepareBound(); const second = owner.prepareBound();
    expect(calls.map(call => call.operation)).toEqual(["bind"]);
    bound.resolve(undefined);
    const prepared = await first;
    expect(prepared).toEqual(await second);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.map(({ operation, sequence }) => ({ operation, sequence }))).toEqual([
      { operation: "bind", sequence: 1 }, { operation: "ping", sequence: 2 },
    ]);
    releasePrepared(owner, prepared);
    await owner.replaceGeneration();
    expect(calls[2]).toMatchObject({ operation: "fence", generation: 1, sequence: 3 });
    await owner.prepareBound();
    expect(calls[3]).toMatchObject({ operation: "bind", generation: 2, sequence: 1 });
    await owner.dispose();
    expect(calls[4]).toMatchObject({ operation: "fence", generation: 2, sequence: 2 });
  } finally { await owner.dispose(); vi.useRealTimers(); }
});

it("shares generation fencing with disposal and rejects overlapping replacements", async () => {
  const fence = Promise.withResolvers<undefined>();
  const calls: AssistanceVmRequest[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    superviseAssistance(_id, request) {
      calls.push(request); return request.operation === "fence" ? fence.promise : Promise.resolve();
    },
  });
  try {
    releasePrepared(owner, await owner.prepareBound());
    const replacing = owner.replaceGeneration();
    await expect(owner.replaceGeneration()).rejects.toThrow("changing");
    const disposing = owner.dispose();
    expect(owner.dispose()).toBe(disposing);
    await Promise.resolve(); await Promise.resolve();
    expect(calls.filter(call => call.operation === "fence")).toHaveLength(1);
    fence.resolve(undefined);
    await replacing; await disposing;
    expect(() => owner.prepare()).toThrow("disposing");
  } finally { fence.resolve(undefined); await owner.dispose(); }
});

it("retires a late guest binding before duplicate disposal completes", async () => {
  const bound = Promise.withResolvers<undefined>();
  const operations: string[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    superviseAssistance(_id, request) {
      operations.push(request.operation); return request.operation === "bind" ? bound.promise : Promise.resolve();
    },
  });
  const preparing = owner.prepareBound();
  const rejected = expect(preparing).rejects.toThrow("disposing");
  const disposing = owner.dispose();
  expect(owner.dispose()).toBe(disposing);
  expect(operations).toEqual(["bind"]);
  bound.resolve(undefined);
  await rejected; await disposing;
  expect(operations).toEqual(["bind", "fence"]);
});

it("permits the normal guest stop after completed assistance disposal", async () => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
  });
  releasePrepared(owner, await owner.prepareBound());
  await owner.dispose();
  await expect(owner.quiesce()).resolves.toBeUndefined();
  await expect(owner.replaceGeneration()).rejects.toThrow("disposing");
});

it("aborts a failed v5 binding without waiting for process credits or sequence space", async () => {
  const operations: string[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    superviseAssistance: (_id, request) => { operations.push(request.operation); return Promise.resolve(); },
  });
  await owner.prepareBound();
  owner.executionStopped(new Error("sequence exhausted"));
  await expect(owner.dispose()).rejects.toThrow("sequence exhausted");
  expect(operations).toEqual(["bind", "abort"]);
});

it("fails a bound v5 generation when guest execution stops before any process exists", async () => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    superviseAssistance: vi.fn(async () => {}),
  });
  await owner.prepareBound();
  owner.executionStopped(new Error("bound guest stopped"));
  try {
    expect(() => owner.assertHealthy()).toThrow("bound guest stopped");
    await expect(owner.dispose()).rejects.toThrow("bound guest stopped");
  } finally { await owner.dispose().catch(() => {}); }
});

it("reserves bootstrap copies before loading and fences stale rollback receipts", async () => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
  });
  try {
    const prepared = await owner.prepareBound();
    expect(prepared.credits).toHaveLength(2);
    expect(prepared.credits?.map(credit => credit.bytes)).toEqual([1, 4098]);
    expect(() => owner.assertIdle()).toThrow("bootstrap");
    const reservation = prepared.credits?.[0]?.reservation;
    if (reservation === undefined) throw new Error("Missing bootstrap reservation");
    expect(() => owner.releaseBootstrap({ ...prepared, reservation: reservation + 100 })).toThrow();
    owner.releaseBootstrap({ ...prepared, reservation });
    expect(() => owner.releaseBootstrap({ ...prepared, reservation })).toThrow();
    const retry = await owner.prepareBound();
    expect(retry.credits?.[0]?.reservation).toBeGreaterThan(reservation);
    const next = retry.credits?.[0]?.reservation;
    if (next === undefined) throw new Error("Missing retry reservation");
    owner.releaseBootstrap({ ...retry, reservation: next });
    owner.assertIdle();
  } finally { await owner.dispose(); }
});

it.each([6, 7] as const)("issues guest windows before v%s start and returns them only after retirement", async version => {
  const operations: string[] = [];
  const agent = { setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: version,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    superviseAssistance(_id: number, request: AssistanceVmRequest): Promise<void> { operations.push(request.operation); return Promise.resolve(); },
    creditAssistance(_id: number, credit: AssistanceCredit): Promise<AssistanceCredit> {
      operations.push(`${credit.kind}:${credit.pool}`); return Promise.resolve(credit);
    },
    assistance(_id: number, request: AssistanceRequest): Promise<AssistanceReply> {
      operations.push(request.operation.kind);
      return Promise.resolve({ ...request, result: request.operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  };
  const owner = new SystemAssistance(agent);
  const broker = new MessageChannel(); const output = new MessageChannel();
  let brokerGrants: readonly AssistanceCredit[] = [];
  broker.port2.onmessage = (event: MessageEvent<unknown>) => {
    if (replyToShutdown(broker.port2, event.data)) return;
    const command = decodeBrokerCommand(event.data);
    if (command.kind === "reserve") brokerGrants = command.credits;
    if (command.kind === "stop") broker.port2.postMessage({ kind: "retired", identity: command.identity,
      credits: brokerGrants.map(credit => ({ ...credit, kind: "return" })) });
    if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
  };
  try {
    const prepared = await owner.prepareBound(); attach(owner, broker.port1, prepared.credits?.[1]);
    const process = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    expect(brokerGrants).toHaveLength(2);
    expect(operations).toEqual(["bind", "grant:data", "grant:control", "start"]);
    await owner.stop(process.pid, "KILL");
    expect(operations.slice(-3)).toEqual(["stop", "return:data", "return:control"]);
    await owner.dispose(); expect(operations.at(-1)).toBe("fence");
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it.each(["current", "stale", "cancel"] as const)("checks current dependency inputs before worker creation: %s", async outcome => {
  const entered = Promise.withResolvers<AssistanceRequest>();
  const checked = Promise.withResolvers<AssistanceReply>();
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation,
    installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 7,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), superviseAssistance: vi.fn(async () => {}),
    assistance(_id, request) {
      if (request.operation.kind === "check-dependencies") { entered.resolve(request); return checked.promise; }
      return Promise.resolve({ ...request, result: request.operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  let credits: readonly AssistanceCredit[] = [];
  let started: ReturnType<typeof decodeBrokerCommand> | undefined;
  broker.port2.onmessage = (event: MessageEvent<unknown>) => {
    if (replyToShutdown(broker.port2, event.data)) return;
    const command = decodeBrokerCommand(event.data);
    if (command.kind === "reserve") credits = command.credits;
    if (command.kind === "stop") broker.port2.postMessage({ kind: "retired", identity: command.identity,
      credits: credits.map(credit => ({ ...credit, kind: "return" })) });
    if (command.kind === "start") {
      started = command;
      broker.port2.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
    }
  };
  const storage = { readBuildPolicy: vi.fn(() => Promise.resolve([])) };
  try {
    const prepared = await owner.prepareBound(); attach(owner, broker.port1, prepared.credits?.[1]);
    const spawning = owner.spawn(92, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1, workspaceBaseSha256: "a".repeat(64) }, storage);
    const rejected = outcome === "current" ? undefined : expect(spawning).rejects.toMatchObject({ code: outcome === "stale" ? "FEATURE_NOT_AVAILABLE" : "ABORTED" });
    const request = await entered.promise;
    expect(request.operation).toEqual({ kind: "check-dependencies", policy: Uint8Array.of(91, 93) });
    expect(storage.readBuildPolicy).toHaveBeenCalledWith("a".repeat(64), expect.any(AbortSignal));
    expect(started).toBeUndefined();
    expect(() => owner.assertIdle()).toThrow();
    if (outcome === "cancel") {
      owner.cancel(92);
      checked.reject(new VMError("ABORTED", "Native verification retired"));
    } else checked.resolve({ ...request, result: outcome === "current"
      ? { kind: "data", bytes: new Uint8Array(64).fill(7) }
      : { kind: "error", errno: 116, code: "ESTALE", syscall: "check-dependencies", path: null, destination: null } });
    if (outcome === "current") {
      const process = await spawning;
      expect(started).toMatchObject({ dependencies: { generation: "07".repeat(32), inputsSha256: "07".repeat(32) } });
      await owner.stop(process.pid, "KILL");
    } else { await rejected; expect(started).toBeUndefined(); }
    owner.assertIdle();
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it("acknowledges a retained guest failure returned by a racing stop before releasing its task", async () => {
  const operations: string[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 6,
    superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      operations.push(request.operation.kind);
      return Promise.resolve({ ...request, result: request.operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} }
        : request.operation.kind === "stop" ? { kind: "terminal", sequence: 19, errno: 32 } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  let credits: readonly AssistanceCredit[] = [];
  broker.port2.onmessage = (event: MessageEvent<unknown>) => {
    if (replyToShutdown(broker.port2, event.data)) return;
    const command = decodeBrokerCommand(event.data);
    if (command.kind === "reserve") credits = command.credits;
    if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
    if (command.kind === "stop") broker.port2.postMessage({ kind: "retired", identity: command.identity,
      credits: credits.map(credit => ({ ...credit, kind: "return" })) });
  };
  const terminated = Promise.withResolvers<unknown>();
  output.port2.onmessage = (event: MessageEvent<unknown>) => terminated.resolve(event.data);
  try {
    const prepared = await owner.prepareBound(); attach(owner, broker.port1, prepared.credits?.[1]);
    const process = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    await owner.stop(process.pid, "KILL");
    expect(operations).toEqual(["start", "stop", "terminal-ack"]);
    expect(await terminated.promise).toMatchObject({ type: "error", error: { code: "GUEST_CRASH", detail: { errno: 32 } } });
    owner.assertIdle();
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

it.each([4, 7] as const)("closes a transferred process port when guest v%i admission fails before task creation", async version => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: false, assistanceVersion: version, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(), setAssistanceEvents: vi.fn(), assistance: vi.fn() });
  const output = new MessageChannel();
  const close = vi.spyOn(output.port1, "close");
  try {
    await expect(owner.spawn(1, { entry: "a.cjs", cwd: "/", args: [], env: {}, port: output.port1 })).rejects.toThrow("successful native admission probe");
    expect(close).toHaveBeenCalledOnce();
  } finally { await owner.dispose(); output.port2.close(); }
});

it("fails the VM generation when the guest transport dies during otherwise live broker execution", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const health = vi.fn(() => Promise.reject(new Error("guest writer lost")));
  const agent = { creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: health, setAssistanceEvents: vi.fn(),
    assistance(_id: number, request: AssistanceRequest): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  };
  const owner = new SystemAssistance(agent);
  const broker = new MessageChannel(); const output = new MessageChannel();
  broker.port2.onmessage = (message: MessageEvent<unknown>) => {
    const value = message.data;
    if (typeof value === "object" && value !== null && "kind" in value && value.kind === "ping") return;
    const command = decodeBrokerCommand(value);
    if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: command.identity });
  };
  attach(owner, broker.port1);
  try {
    const spawned = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    const process = new GuestProcessTransport(output.port2, spawned.pid, spawned.sessionId, {
      write: bytes => Promise.resolve(bytes.length), closeStdin: () => Promise.resolve(), signal: () => Promise.resolve(),
    });
    const outcome = process.exit.then(value => value, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(health).toHaveBeenCalledOnce();
    expect(() => owner.assertHealthy()).toThrow("guest writer lost");
    await expect(owner.dispose()).rejects.toThrow("guest writer lost");
    expect(await outcome).toMatchObject({ message: "guest writer lost" });
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); vi.useRealTimers(); }
});

it("closes a rejected transferred broker port without replacing its owner", async () => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn() });
  const broker = new MessageChannel();
  const duplicate = new MessageChannel();
  const close = vi.spyOn(duplicate.port1, "close");
  attach(owner, broker.port1);
  try {
    expect(() => attach(owner, duplicate.port1)).toThrow("already attached");
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await owner.dispose(); broker.port2.close(); duplicate.port1.close(); duplicate.port2.close();
  }
});

it("routes authenticated guest events to the bound process independently of requests", async () => {
  let events: ((event: AssistanceEvent) => void) | undefined;
  const owner = new SystemAssistance({
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents(receive) { events = receive; },
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: { PATH: "/bin" } } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  const forwarded = Promise.withResolvers<AssistanceEvent>();
  broker.port2.onmessage = (message: MessageEvent<unknown>) => {
    const command = decodeBrokerCommand(message.data);
    if (command.kind === "start") {
      expect(command.env).toEqual({ PATH: "/bin" });
      broker.port2.postMessage({ kind: "ready", identity: command.identity });
    } else if (command.kind === "event") {
      expect(command.identity.sequence).toBe(2);
      forwarded.resolve(decodeAssistanceEvent(command.bytes));
    }
  };
  attach(owner, broker.port1);
  try {
    const process = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    const event: AssistanceEvent = { ...owner.prepare(), process: process.pid, sequence: 7,
      event: { kind: "eof", child: 1, stream: "stdout" } };
    if (events === undefined) throw new Error("Missing guest event owner");
    events(event);
    await expect(forwarded.promise).resolves.toEqual(event);
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it("bounds unacknowledged native child output independently per stream", async () => {
  const acknowledged = Promise.withResolvers<undefined>();
  let receive: ((event: AssistanceEvent) => void) | undefined;
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: () => Promise.resolve(),
    setAssistanceEvents(callback) { receive = callback; },
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      if (operation.kind === "ack") acknowledged.resolve(undefined);
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  attach(owner, broker.port1); readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    const binding = owner.prepare();
    if (receive === undefined) throw new Error("Missing event receiver");
    for (let sequence = 1; sequence <= 16; sequence++) receive({ ...binding, process: 1, sequence,
      event: { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array(65536) } });
    expect(() => owner.prepare()).not.toThrow();
    broker.port2.postMessage({ kind: "request", identity: { ...binding, process: 1, sequence: 2 },
      operation: { kind: "ack", child: 1, stream: "stdout", sequence: 1, bytes: 65536 } });
    await acknowledged.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    receive({ ...binding, process: 1, sequence: 17,
      event: { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array(65536) } });
    expect(() => owner.prepare()).not.toThrow();
    receive({ ...binding, process: 1, sequence: 18,
      event: { kind: "output", child: 1, stream: "stdout", bytes: Uint8Array.of(1) } });
    await expect(owner.dispose()).rejects.toThrow("Child output capacity");
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

it("keeps separate stdout and stderr queue limits", async () => {
  const reached = vi.fn();
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: () => Promise.resolve(), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      if (operation.kind === "close") reached();
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  attach(owner, broker.port1); readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    let sequence = 1;
    for (const stream of ["stdout", "stderr"] as const) {
      for (let index = 0; index < 16; index++) broker.port2.postMessage({ kind: "output",
        identity: { ...owner.prepare(), process: 1, sequence: ++sequence }, stream, bytes: new Uint8Array(65536) });
    }
    broker.port2.postMessage({ kind: "request", identity: { ...owner.prepare(), process: 1, sequence: ++sequence }, operation: { kind: "close", fd: 1 } });
    await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
    expect(() => owner.prepare()).not.toThrow();
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

function readyBroker(port: MessagePort): void {
  port.onmessage = (event: MessageEvent<unknown>) => {
    const command = decodeBrokerCommand(event.data);
    if (command.kind === "start") port.postMessage({ kind: "ready", identity: command.identity });
  };
  port.start();
}

it.each([
  { kind: "start", cwd: "/", env: {} },
  { kind: "stop" },
  { kind: "terminal-ack", sequence: 1 },
] as const)("rejects process-issued lifecycle operation $kind before guest dispatch", async operation => {
  const requests: AssistanceRequest[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: () => Promise.resolve(), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      requests.push(request);
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  attach(owner, broker.port1); readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    broker.port2.postMessage({ kind: "request", identity: { ...owner.prepare(), process: 1, sequence: 2 }, operation });
    await vi.waitFor(() => expect(() => owner.prepare()).toThrow("disposing"));
    await expect(owner.dispose()).rejects.toThrow("cannot acquire or retire");
    expect(requests.map(request => request.operation.kind)).toEqual(["start", "stop"]);
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

it("cancels a backpressured stdin write without waiting for its process worker", async () => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  attach(owner, broker.port1); readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    const pending = owner.input(1, new Uint8Array(65536));
    const rejected = expect(pending).rejects.toThrow("stopped");
    expect(() => owner.input(1, Uint8Array.of(1))).toThrow("Concurrent");
    await owner.stop(1, "KILL");
    await rejected;
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it("fences a cancelled in-flight guest completion without poisoning restart", async () => {
  const pending = Promise.withResolvers<AssistanceReply>();
  const dispatched = Promise.withResolvers<undefined>();
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      if (operation.kind === "open") { dispatched.resolve(undefined); return pending.promise; }
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  attach(owner, broker.port1); readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    broker.port2.postMessage({ kind: "request", identity: { ...owner.prepare(), process: 1, sequence: 2 },
      operation: { kind: "open", path: "/workspace/fifo", flags: 0, mode: 0o600 } });
    await dispatched.promise;
    await owner.stop(1, "KILL");
    pending.reject(new Error("Operation canceled (os error 125)"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(() => owner.prepare()).not.toThrow();
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

it("does not resolve spawn until the process worker reports readiness", async () => {
  const owner = new SystemAssistance({
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel();
  const output = new MessageChannel();
  const start = Promise.withResolvers<unknown>();
  broker.port2.onmessage = (event: MessageEvent<unknown>) => start.resolve(event.data);
  attach(owner, broker.port1);
  let resolved = false;
  const spawned = owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
  void spawned.then(() => { resolved = true; }, () => {});
  try {
    const command = decodeBrokerCommand(await start.promise);
    expect(command.kind).toBe("start");
    expect(resolved).toBe(false);
    broker.port2.postMessage({ kind: "ready", identity: command.identity });
    await expect(spawned).resolves.toEqual({ pid: 1, sessionId: 1 });
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it("retires a compiler-initializing task when its control request is cancelled", async () => {
  const operations: AssistanceRequest[] = [];
  const owner = new SystemAssistance({
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      operations.push(request);
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel();
  const output = new MessageChannel();
  const start = Promise.withResolvers<unknown>();
  broker.port2.onmessage = (event: MessageEvent<unknown>) => start.resolve(event.data);
  attach(owner, broker.port1);
  const spawned = owner.spawn(17, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
  const rejected = expect(spawned).rejects.toThrow("cancelled");
  try {
    await start.promise;
    owner.cancel(17);
    await rejected;
    expect(operations.map(request => request.operation.kind)).toEqual(["start", "stop"]);
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

describe("control-owned assistance lifecycle", () => {
  it("starts and retires a Linux task through one shared disposal owner", async () => {
    const started: AssistanceRequest[] = [];
    const agent = {
      creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
      setAssistanceEvents: vi.fn(),
      assistance(_id: number, request: AssistanceRequest): Promise<AssistanceReply> {
        started.push(request);
        const { operation, ...identity } = request;
        void operation;
        return Promise.resolve({ ...identity, result: request.operation.kind === "start"
          ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
      },
    };
    const owner = new SystemAssistance(agent);
    const broker = new MessageChannel();
    const output = new MessageChannel();
    attach(owner, broker.port1);
  readyBroker(broker.port2);
    try {
      const binding = owner.prepare();
      const spawned = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
      expect(spawned.pid).toBe(1);
      expect(started[0]?.operation).toEqual({ kind: "start", cwd: "/workspace", env: {} });
      expect(() => owner.assertIdle()).toThrow();
      await owner.stop(spawned.pid, "KILL");
      expect(started.at(-1)?.operation).toEqual({ kind: "stop" });
      expect(started.at(-1)?.session).toBe(binding.session);
      expect(() => owner.assertIdle()).not.toThrow();
      await owner.dispose();
      await owner.dispose();
    } finally {
      await owner.dispose();
      broker.port2.close(); output.port2.close();
    }
  });
});

it("forwards broker output through public stream acknowledgements before exit", async () => {
  const agent = {
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn(),
    assistance(_id: number, request: AssistanceRequest): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  };
  const owner = new SystemAssistance(agent);
  const broker = new MessageChannel();
  const output = new MessageChannel();
  const binding = owner.prepare();
  attach(owner, broker.port1);
  readyBroker(broker.port2);
  try {
    const started = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    const process = new GuestProcessTransport(output.port2, started.pid, started.sessionId, {
      write: () => Promise.reject(new Error("unused")), closeStdin: () => Promise.resolve(), signal: signal => owner.stop(started.pid, signal),
    });
    const bytes = new TextEncoder().encode("linux-backed\n");
    broker.port2.postMessage({ kind: "output", identity: { ...binding, process: started.pid, sequence: 2 }, stream: "stdout", bytes });
    broker.port2.postMessage({ kind: "exit", identity: { ...binding, process: started.pid, sequence: 3 }, code: 0 });
    const reader = process.stdout.getReader();
    expect(await reader.read()).toEqual({ done: false, value: bytes });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await expect(process.exit).resolves.toEqual({ code: 0 });
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it("retires an already-ready process when its original spawn reply is cancelled in transit", async () => {
  const operations: string[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4,
    superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      operations.push(request.operation.kind);
      return Promise.resolve({ ...request, result: request.operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  attach(owner, broker.port1); readyBroker(broker.port2);
  try {
    await owner.spawn(31, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    owner.cancel(31);
    await vi.waitFor(() => expect(operations).toEqual(["start", "stop"]));
    await vi.waitFor(() => owner.assertIdle());
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it("cancels startup without resurrecting a task when its delayed startup reply arrives", async () => {
  const startup = Promise.withResolvers<AssistanceReply>();
  let request: AssistanceRequest | undefined;
  const owner = new SystemAssistance({
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn(),
    assistance(_id, value) {
      if (value.operation.kind === "start") { request = value; return startup.promise; }
      const { operation, ...identity } = value;
      void operation;
      return Promise.resolve({ ...identity, result: { kind: "unit" } });
    },
  });
  const broker = new MessageChannel();
  const output = new MessageChannel();
  attach(owner, broker.port1);
  readyBroker(broker.port2);
  try {
    const spawned = owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    const rejected = expect(spawned).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(request).toBeDefined());
    await owner.stop(1, "KILL");
    if (request === undefined) throw new Error("start was not sent");
    const { operation, ...identity } = request;
        void operation;
    startup.resolve({ ...identity, result: { kind: "started", cwd: "/workspace", env: {} } });
    await rejected;
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await owner.dispose(); broker.port2.close(); output.port2.close(); }
});

it("retains task ownership and fails the generation when Linux rejects retirement", async () => {
  const owner = new SystemAssistance({
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} }
        : { kind: "error", errno: 5, code: "EIO", syscall: "stop", path: null, destination: null } });
    },
  });
  const broker = new MessageChannel();
  const output = new MessageChannel();
  attach(owner, broker.port1);
  readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    await expect(owner.stop(1, "KILL")).rejects.toThrow("retire");
    expect(() => owner.assertIdle()).toThrow();
    expect(() => owner.prepare()).toThrow();
    await expect(owner.dispose()).rejects.toThrow();
  } finally { broker.port1.close(); broker.port2.close(); output.port1.close(); output.port2.close(); }
});

it("rejects queued output after cancellation without poisoning the reusable generation", async () => {
  const owner = new SystemAssistance({
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
    setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      return Promise.resolve({ ...identity, result: operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel();
  const output = new MessageChannel();
  const binding = owner.prepare();
  attach(owner, broker.port1);
  readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    await owner.stop(1, "KILL");
    broker.port2.postMessage({ kind: "output", identity: { ...binding, process: 1, sequence: 1 }, stream: "stdout", bytes: Uint8Array.of(1) });
    // A round trip through the same port observes delivery of the queued output.
    const delivered = Promise.withResolvers<undefined>();
    broker.port1.addEventListener("message", () => delivered.resolve(undefined), { once: true });
    await delivered.promise;
    await Promise.resolve();
    expect(owner.rejectedRetiredEvents).toBe(1);
    expect(() => owner.assertIdle()).not.toThrow();
    expect(() => owner.prepare()).not.toThrow();
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

function replyToShutdown(port: MessagePort, value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "shutdown") return false;
  port.postMessage({ ...decodeBrokerShutdown(value), kind: "stopped" });
  return true;
}
function releasePrepared(owner: SystemAssistance, prepared: AssistancePreparation): void {
  const reservation = prepared.credits?.[0]?.reservation;
  if (reservation === undefined) throw new Error("Missing prepared credits");
  owner.releaseBootstrap({ ...prepared, reservation });
}
function attach(owner: SystemAssistance, port: MessagePort, staging?: AssistanceCredit): void {
  if (ASSISTANCE_ARTIFACTS === undefined) throw new Error("missing test artifacts");
  owner.attach({ ...owner.prepare(), port, artifacts: ASSISTANCE_ARTIFACTS,
    ...(staging === undefined ? {} : { receipt: { ...staging, kind: "return" } }) });
}

it("closes broker attachments rejected by capability, artifact, or generation validation", async () => {
  if (ASSISTANCE_ARTIFACTS === undefined) throw new Error("missing test artifacts");
  const artifacts = ASSISTANCE_ARTIFACTS;
  for (const failure of ["capability", "artifact", "generation"] as const) {
    const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: failure !== "capability", assistanceVersion: 4 as const, superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(), setAssistanceEvents: vi.fn(), assistance: vi.fn() });
    const broker = new MessageChannel();
    const close = vi.spyOn(broker.port1, "close");
    const binding = failure === "capability" ? { session: crypto.randomUUID(), generation: 1 } : owner.prepare();
    try {
      expect(() => owner.attach({ ...binding, generation: failure === "generation" ? binding.generation + 1 : binding.generation,
        artifacts: failure === "artifact" ? { ...artifacts, runtime: { bytes: 1, sha256: "f".repeat(64) } } : artifacts,
        port: broker.port1 })).toThrow();
      expect(close).toHaveBeenCalledOnce();
    } finally { await owner.dispose(); broker.port1.close(); broker.port2.close(); }
  }
});

it.each(["readdir", "readdir-entries"] as const)("budgets %s replies and cancels queued work on retirement", async (kind) => {
  const acquire = vi.spyOn(AssistanceTraffic.prototype, "acquire");
  const pending: PromiseWithResolvers<AssistanceReply>[] = [];
  const calls: AssistanceRequest[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 4,
    superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      calls.push(request);
      if (request.operation.kind === kind) {
        const reply = Promise.withResolvers<AssistanceReply>(); pending.push(reply); return reply.promise;
      }
      return Promise.resolve({ ...request, result: request.operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  attach(owner, broker.port1); readyBroker(broker.port2);
  try {
    await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    for (let sequence = 2; sequence <= 25; sequence++) broker.port2.postMessage({ kind: "request",
      identity: { ...owner.prepare(), process: 1, sequence }, operation: { kind, path: "/workspace" } });
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pending.length).toBeLessThan(24);
    const reserved = acquire.mock.calls.at(-1)?.[1];
    expect(reserved).toBeGreaterThanOrEqual(ASSISTANCE_LIMITS.request * 2 + (ASSISTANCE_LIMITS.chunk + 128) * 8);
    const dispatched = pending.length;
    await owner.stop(1, "KILL");
    for (const reply of pending) reply.reject(new Error("task stopped"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls.filter(call => call.operation.kind === kind)).toHaveLength(dispatched);
    expect(calls.at(-1)?.operation.kind).toBe("stop");
    owner.assertIdle();
  } finally {
    acquire.mockRestore();
    for (const reply of pending) reply.reject(new Error("cleanup"));
    await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close();
  }
});

function echoCredit(_id: number, credit: AssistanceCredit): Promise<AssistanceCredit> { return Promise.resolve(credit); }

for (const source of ["event", "request"] as const) {
  it.each([6, 7] as const)(`retires only the failed Linux task when ${source} reports helper loss (guest %s)`, async version => {
    let receive: ((event: AssistanceEvent) => void) | undefined;
    const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: version,
      superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}),
      setAssistanceEvents(callback) { receive = callback; },
      assistance(_id, request): Promise<AssistanceReply> {
        if (request.operation.kind === "read") return Promise.reject(new VMError("STORAGE_ERROR", "helper disconnected", {
          agentStatus: 4, agentKind: AgentKind.assistance,
        }));
        return Promise.resolve({ ...request, result: request.operation.kind === "start"
          ? { kind: "started", cwd: "/workspace", env: {} }
          : request.operation.kind === "stop" && request.process === 1
            ? { kind: "terminal", sequence: 19, errno: 32 } : { kind: "unit" } });
      },
    });
    const networkPorts = new MessageChannel();
    const network = new SystemNetworkChannel(networkPorts.port1);
    owner.attachNetwork(networkPorts.port2);
    const broker = new MessageChannel(); const first = new MessageChannel(); const second = new MessageChannel();
    const credits = new Map<number, readonly AssistanceCredit[]>();
    broker.port2.onmessage = (event: MessageEvent<unknown>) => {
      if (replyToShutdown(broker.port2, event.data)) return;
      const command = decodeBrokerCommand(event.data);
      if (command.kind === "reserve") credits.set(command.identity.process, command.credits);
      if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
      if (command.kind === "stop") broker.port2.postMessage({ kind: "retired", identity: command.identity,
        credits: credits.get(command.identity.process)?.map(credit => ({ ...credit, kind: "return" })) });
    };
    const terminated = Promise.withResolvers<unknown>();
    first.port2.onmessage = (event: MessageEvent<unknown>) => terminated.resolve(event.data);
    try {
      const prepared = await owner.prepareBound(); attach(owner, broker.port1, prepared.credits?.[1]);
      await owner.spawn(1, { entry: "one.cjs", cwd: "/", args: [], env: {}, port: first.port1 });
      await owner.spawn(2, { entry: "two.cjs", cwd: "/", args: [], env: {}, port: second.port1 });
      if (source === "event") {
        if (receive === undefined) throw new Error("Missing event receiver");
        receive({ ...owner.prepare(), process: 1, sequence: 19, event: { kind: "failure", errno: 32 } });
      } else broker.port2.postMessage({ kind: "request", identity: { ...owner.prepare(), process: 1, sequence: 2 },
        operation: { kind: "read", fd: 1, length: 1, offset: null } });
      expect(await terminated.promise).toMatchObject({ type: "error", error: { code: "GUEST_CRASH" } });
      expect(() => owner.assertHealthy()).not.toThrow();
      expect(() => owner.assertIdle()).toThrow();
      await owner.stop(2, "KILL");
      owner.assertIdle();
    } finally { await owner.dispose().catch(() => {}); broker.port2.close(); first.port2.close(); second.port2.close(); network.close(); }
  });
}

function unexpectedInstallation(): Promise<never> { return Promise.reject(new Error("Unexpected installation in task test")); }

it.each(["cancel", "dispose"])("holds VM admission while approval persistence settles after %s", async action => {
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation,
    installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 7,
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(), superviseAssistance: vi.fn(async () => {}),
  });
  const settled = Promise.withResolvers<undefined>();
  let cancellation: AbortSignal | undefined;
  const storage = { commitBuildPolicy: vi.fn((_base: string, _decisions: unknown, signal?: AbortSignal) => {
    cancellation = signal;
    return settled.promise;
  }) };
  const request = { workspaceBaseSha256: "a".repeat(64), decisions: [] };
  const pending = owner.commitBuildPolicy(91, storage, request);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await vi.waitFor(() => expect(storage.commitBuildPolicy).toHaveBeenCalledOnce());
  expect(() => owner.assertIdle()).toThrow("approval persistence");
  await expect(owner.commitBuildPolicy(92, storage, request)).rejects.toThrow("approval persistence");
  const retiring = action === "dispose" ? owner.dispose() : undefined;
  if (action === "cancel") owner.cancel(91);
  expect(cancellation?.aborted).toBe(true);
  expect(() => owner.assertIdle()).toThrow("approval persistence");
  settled.reject(new VMError("ABORTED", "Approval cancelled"));
  await rejected;
  await retiring;
  if (action === "cancel") owner.assertIdle();
  await owner.dispose();
});


it.each(["close", "cancel"] as const)("orders listener admission with task retirement: %s", async action => {
  const native: string[] = [];
  const owner = new SystemAssistance({ creditAssistance: echoCredit, setInstallationEvents: vi.fn(),
    startInstallation: unexpectedInstallation, installation: unexpectedInstallation, supportsAssistance: true, assistanceVersion: 7,
    superviseAssistance: vi.fn(async () => {}), checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    assistance(_id, request): Promise<AssistanceReply> {
      const { operation, ...identity } = request;
      native.push(operation.kind);
      return Promise.resolve({ ...identity, result: operation.kind === "start"
        ? { kind: "started", cwd: "/workspace", env: {} }
        : operation.kind === "socket-listen"
          ? { kind: "socket", fd: 7, local: { address: "127.0.0.1", port: 3000 }, peer: null }
          : { kind: "unit" } });
    },
  });
  const networkPorts = new MessageChannel();
  const network = new SystemNetworkChannel(networkPorts.port1);
  void network.done.catch(() => owner.networkFailed());
  owner.attachNetwork(networkPorts.port2);
  const sent = networkPorts.port1.postMessage.bind(networkPorts.port1);
  const admission = Promise.withResolvers<unknown>();
  vi.spyOn(networkPorts.port1, "postMessage").mockImplementation((value: unknown) => {
    const message = decodeSystemNetworkMessage(value);
    if (message.kind === "pong" && message.sequence === 3) admission.resolve(value);
    else sent(value);
  });
  const broker = new MessageChannel(); const output = new MessageChannel();
  let credits: readonly AssistanceCredit[] = [];
  const replies: number[] = [];
  broker.port2.onmessage = (event: MessageEvent<unknown>) => {
    if (replyToShutdown(broker.port2, event.data)) return;
    const command = decodeBrokerCommand(event.data);
    if (command.kind === "reserve") credits = command.credits;
    if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
    if (command.kind === "reply") replies.push(command.identity.sequence);
    if (command.kind === "stop") broker.port2.postMessage({ kind: "retired", identity: command.identity,
      credits: credits.map(credit => ({ ...credit, kind: "return" })) });
  };
  try {
    const prepared = await owner.prepareBound(); attach(owner, broker.port1, prepared.credits?.[1]);
    await owner.spawn(1, { entry: "server.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    broker.port2.postMessage({ kind: "request", identity: { ...owner.prepare(), process: 1, sequence: 2 },
      operation: { kind: "socket-listen", address: { address: "127.0.0.1", port: 3000 }, backlog: 16 } });
    const receipt = await admission.promise;
    expect(native).toEqual(["start", "socket-listen"]);
    expect(replies).toEqual([]);
    if (action === "cancel") {
      const stopping = owner.stop(1, "KILL");
      await vi.waitFor(() => expect(native.at(-1)).toBe("stop"));
      sent(receipt);
      await stopping;
      expect(replies).toEqual([]);
      expect(native).toEqual(["start", "socket-listen", "stop"]);
    } else {
      sent(receipt);
      await vi.waitFor(() => expect(replies).toEqual([2]));
      broker.port2.postMessage({ kind: "request", identity: { ...owner.prepare(), process: 1, sequence: 3 },
        operation: { kind: "socket-close", fd: 7 } });
      await vi.waitFor(() => expect(replies).toEqual([2, 3]));
      await owner.stop(1, "KILL");
      expect(native).toEqual(["start", "socket-listen", "socket-close", "stop"]);
    }
    owner.assertIdle();
    await owner.dispose();
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); network.close(); }
});

it("fails a retirement whose broker never reports its worker retired with the stalled step", async () => {
  const operations: string[] = [];
  const agent = {
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation,
    supportsAssistance: true, assistanceVersion: 7 as const, checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    superviseAssistance: vi.fn(async () => {}),
    assistance(_id: number, request: AssistanceRequest): Promise<AssistanceReply> {
      operations.push(request.operation.kind);
      return Promise.resolve({ ...request, result: request.operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  };
  const owner = new SystemAssistance(agent, { retirementStepMs: 50 });
  const broker = new MessageChannel(); const output = new MessageChannel();
  broker.port2.onmessage = (event: MessageEvent<unknown>) => {
    if (replyToShutdown(broker.port2, event.data)) return;
    const command = decodeBrokerCommand(event.data);
    // The broker takes the stop but never reports the worker retired.
    if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
  };
  try {
    const prepared = await owner.prepareBound(); attach(owner, broker.port1, prepared.credits?.[1]);
    const process = await owner.spawn(1, { entry: "entry.cjs", cwd: "/", args: [], env: {}, port: output.port1 });
    await expect(owner.stop(process.pid, "KILL")).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { step: "broker-retired", process: process.pid } });
    expect(operations).toContain("stop");
    await expect(owner.dispose()).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { step: "broker-retired" } });
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

it("fails a disposal whose broker never answers its shutdown with the stalled step", async () => {
  const agent = {
    creditAssistance: echoCredit, setInstallationEvents: vi.fn(), startInstallation: unexpectedInstallation, installation: unexpectedInstallation,
    supportsAssistance: true, assistanceVersion: 7 as const, checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(),
    superviseAssistance: vi.fn(async () => {}),
    assistance(_id: number, request: AssistanceRequest): Promise<AssistanceReply> {
      return Promise.resolve({ ...request, result: request.operation.kind === "start" ? { kind: "started", cwd: "/workspace", env: {} } : { kind: "unit" } });
    },
  };
  const owner = new SystemAssistance(agent, { retirementStepMs: 50 });
  const broker = new MessageChannel(); const output = new MessageChannel();
  broker.port2.onmessage = (event: MessageEvent<unknown>) => {
    // The broker answers everything except its own shutdown.
    if (isKind(event.data, "shutdown")) return;
    const command = decodeBrokerCommand(event.data);
    if (command.kind === "stop") broker.port2.postMessage({ kind: "retired", identity: command.identity, credits: [] });
    if (command.kind === "start") broker.port2.postMessage({ kind: "ready", identity: { ...command.identity, sequence: 1 } });
  };
  try {
    const prepared = await owner.prepareBound(); attach(owner, broker.port1, prepared.credits?.[1]);
    await expect(owner.dispose()).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { step: "broker-shutdown" } });
  } finally { await owner.dispose().catch(() => {}); broker.port2.close(); output.port2.close(); }
});

function isKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind;
}
