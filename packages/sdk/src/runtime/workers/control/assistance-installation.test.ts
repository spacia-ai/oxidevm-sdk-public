import * as workspaceTransfers from "../workspace-transfer.js";
import { INSTALLATION_DATA_GRANT_BYTES, INSTALLATION_PIPE_FIXED_BYTES, INSTALLATION_PIPE_READ_BYTES, INSTALLATION_PIPE_WRITE_BYTES, INSTALLATION_WRITE_WINDOW } from "../../protocol/assistance-installation.js";
import type { WorkspacePublicationResult } from "../../protocol/workspace-publication.js";
import { VMError } from "../../errors.js";
import { WorkspaceStore } from "../workspace-store.js";
import { WorkspacePublications } from "../workspace-publication.js";
import { serveSnapshotStorage } from "../snapshot-storage-server.js";
import { SnapshotStorageClient } from "../snapshot-channel.js";
import { afterEach, expect, it, vi } from "vitest";
import { AssistanceTraffic } from "./assistance-traffic.js";
import { SystemAssistance } from "./assistance.js";
import { SystemNetworkChannel } from "../system-network-channel.js";
import { RegistryClient } from "../registry-client.js";
import { registryBytePipe } from "../registry-pipe.js";
import { GrantedTraffic } from "../assistance/traffic.js";
import type { GuestAgent } from "./guest-agent.js";
import type { InstallationReply } from "../../protocol/assistance-installation-reply.js";
import type { AssistanceCredit } from "../../protocol/assistance-credit.js";

import { ASSISTANCE_ARTIFACTS } from "../../assistance-build.js";
import { decodeBrokerShutdown } from "../../protocol/assistance-broker.js";

vi.mock("../../assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: {
  version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } }, compiler: { sha256: "0".repeat(64), bytes: 1 },
  runtime: { sha256: "0".repeat(64), bytes: 1054077 },
} }));
const policy = { origin: "https://registry.npmjs.org", maximumBytes: 1024 };
afterEach(() => { vi.unstubAllGlobals(); });

it("retires an idle runtime before installation and admits a fresh bootstrap afterward", async () => {
  const { owner, agent, close } = fixture();
  const broker = new MessageChannel();
  broker.port2.onmessage = (event: MessageEvent<unknown>) => {
    broker.port2.postMessage({ ...decodeBrokerShutdown(event.data), kind: "stopped" });
  };
  try {
    const prepared = await owner.prepareBound();
    const staging = prepared.credits?.[1];
    if (staging === undefined || ASSISTANCE_ARTIFACTS === undefined) throw new Error("Missing bootstrap artifacts");
    owner.attach({ ...prepared, port: broker.port1, artifacts: ASSISTANCE_ARTIFACTS,
      receipt: { ...staging, kind: "return" } });
    const installation = await owner.beginInstallation(policy);
    expect(installation.identity.generation).toBe(prepared.generation + 1);
    expect(agent.superviseAssistance.mock.calls.map(([, request]) => request.operation)).toEqual(["bind", "fence", "bind"]);
    await installation.finish();
    const next = await owner.prepareBound();
    expect(next.generation).toBe(installation.identity.generation);
    const retained = next.credits?.[0];
    if (retained === undefined) throw new Error("Missing renewed bootstrap");
    owner.releaseBootstrap({ ...next, reservation: retained.reservation });
  } finally { await close(); broker.port2.close(); }
});

it("rejects invalid registry policy before binding without fencing a healthy VM", async () => {
  const { owner, agent, close } = fixture();
  try {
    await expect(owner.beginInstallation({ ...policy, maximumBytes: -1 })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(agent.superviseAssistance).not.toHaveBeenCalled();
    expect(() => owner.assertIdle()).not.toThrow();
    const installation = await owner.beginInstallation(policy);
    await installation.finish();
  } finally { await close(); }
});

function fixture(binding = Promise.resolve(undefined), version: 6 | 7 = 6) {
  const guest = gatewayFixture();
  const agent = { ...guest.agent, supportsAssistance: true, assistanceVersion: version,
    setInstallationEvents: vi.fn<GuestAgent["setInstallationEvents"]>(),
    checkAssistanceHealth: vi.fn(async () => {}), setAssistanceEvents: vi.fn(), assistance: vi.fn(),
    creditAssistance: vi.fn((_id: number, credit: AssistanceCredit) => Promise.resolve(credit)),
    superviseAssistance: vi.fn((_id, request: { operation: string }) => request.operation === "bind" ? binding : Promise.resolve()),
  };
  const owner = new SystemAssistance(agent);
  const pair = new MessageChannel();
  const network = new SystemNetworkChannel(pair.port1);
  owner.attachNetwork(pair.port2);
  return { owner, agent, guest, close: async () => { await owner.dispose().catch(() => undefined); network.close(); pair.port2.close(); } };
}

it("holds the installation lease from binding through explicit retirement without compiler bootstrap", async () => {
  const binding = Promise.withResolvers<undefined>();
  const { owner, close } = fixture(binding.promise);
  const opening = owner.beginInstallation(policy);
  try {
    expect(() => owner.assertIdle()).toThrow("installation");
    await expect(owner.beginInstallation(policy)).rejects.toThrow("installation");
    await expect(owner.prepareBound()).rejects.toThrow("installation");
    await expect(owner.replaceGeneration()).rejects.toThrow("installation");
    binding.resolve(undefined);
    const installation = await opening;
    expect(installation.identity.installation).toBe(1);
    expect(installation.identity).not.toHaveProperty("process");
    // Retiring the transport alone must not release the publication lease.
    await installation.registry.close();
    expect(() => owner.assertIdle()).toThrow("installation");
    await installation.finish();
    expect(() => owner.assertIdle()).not.toThrow();
    const retry = await owner.beginInstallation(policy);
    expect(retry.identity.installation).toBe(2);
    await retry.finish();
  } finally { binding.resolve(undefined); await opening.catch(() => undefined); await close(); }
});

it("cancels registry producers but retains the lease until preparation cleanup finishes", async () => {
  const { owner, close } = fixture();
  const cancellation = new AbortController();
  try {
    const installation = await owner.beginInstallation(policy, cancellation.signal);
    cancellation.abort();
    await installation.registry.done;
    expect(installation.signal.aborted).toBe(true);
    expect(() => owner.assertIdle()).toThrow("installation");
    await installation.finish();
    const retry = await owner.beginInstallation(policy);
    expect(retry.signal.aborted).toBe(false);
    await retry.finish();
  } finally { await close(); }
});

it("retires cancelled startup before admitting a retry", async () => {
  const binding = Promise.withResolvers<undefined>();
  const { owner, close } = fixture(binding.promise);
  const cancellation = new AbortController();
  const opening = owner.beginInstallation(policy, cancellation.signal);
  const rejected = expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  try {
    cancellation.abort();
    expect(() => owner.assertIdle()).toThrow("installation");
    binding.resolve(undefined);
    await rejected;
    expect(() => owner.assertIdle()).not.toThrow();
    const retry = await owner.beginInstallation(policy);
    await retry.finish();
  } finally { binding.resolve(undefined); await rejected; await close(); }
});

it("disposal cancels an installation and waits for registry retirement", async () => {
  const { owner, close } = fixture();
  try {
    const installation = await owner.beginInstallation(policy);
    const disposal = owner.dispose();
    expect(owner.dispose()).toBe(disposal);
    await disposal;
    expect(installation.signal.aborted).toBe(true);
    await installation.registry.done;
    expect(() => owner.prepare()).toThrow("disposing");
  } finally { await close(); }
});

it("rejects pre-cancelled installation before acquiring guest authority", async () => {
  const { owner, agent, close } = fixture();
  try {
    await expect(owner.beginInstallation(policy, AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
    expect(agent.superviseAssistance).not.toHaveBeenCalled();
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it("keeps admission closed while a registry producer is still retiring", async () => {
  const cancelled = Promise.withResolvers<undefined>();
  const retired = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ type: "bytes",
    cancel() { cancelled.resolve(undefined); return retired.promise; },
  }))));
  const { owner, agent, guest, close } = fixture();
  const output = new MessageChannel();
  try {
    const installation = await owner.beginInstallation(policy);
    const headers = await guest.client().start(policy.origin + "/package").response;
    headers.acknowledge();
    let completed = false;
    const finishing = installation.finish().then(() => { completed = true; });
    await cancelled.promise;
    expect(completed).toBe(false);
    expect(() => owner.assertIdle()).toThrow("installation");
    await expect(owner.spawn(1, { port: output.port1, entry: "index.cjs", cwd: "/", args: [], env: {} })).rejects.toThrow("installation");
    expect(agent.assistance).not.toHaveBeenCalled();
    retired.resolve(undefined);
    await finishing;
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { retired.resolve(undefined); output.port2.close(); await close(); }
});

it("fences the VM on installation network-owner loss", async () => {
  const { owner, close } = fixture();
  try {
    const installation = await owner.beginInstallation(policy);
    owner.networkFailed();
    await expect(owner.dispose()).rejects.toMatchObject({ code: "RELAY_ERROR" });
    await expect(installation.finish()).rejects.toBeDefined();
    await expect(owner.beginInstallation(policy)).rejects.toBeDefined();
  } finally { await close(); }
});


it("issues VM-scoped guest credits and waits for exact returns before releasing installation", async () => {
  const { owner, agent, close } = fixture();
  const retirement = Promise.withResolvers<undefined>();
  try {
    const installation = await owner.beginInstallation(policy);
    const grants = agent.creditAssistance.mock.calls.map(([, credit]) => credit);
    expect(grants).toHaveLength(6);
    expect(grants.map(credit => [credit.producer, credit.process, credit.pool])).toEqual([
      ["installation", null, "data"], ["installation", null, "control"],
      ["installation-gateway", null, "data"], ["installation-gateway", null, "control"],
      ["installation-process", null, "data"], ["installation-process", null, "control"],
    ]);
    expect(grants.filter(credit => credit.producer === "installation-process").map(credit => credit.bytes))
      .toEqual([2 * 1024 * 1024 + 384 * 1024, 128 * 1024]);
    // The pipe grant holds the guest's fixed overhead, one blocking read and the derived write window.
    expect(grants.find(credit => credit.producer === "installation" && credit.pool === "data")?.bytes).toBe(INSTALLATION_DATA_GRANT_BYTES);
    expect(INSTALLATION_WRITE_WINDOW).toBe(3);
    expect(INSTALLATION_PIPE_FIXED_BYTES + INSTALLATION_PIPE_READ_BYTES + INSTALLATION_WRITE_WINDOW * INSTALLATION_PIPE_WRITE_BYTES).toBeLessThanOrEqual(INSTALLATION_DATA_GRANT_BYTES);
    agent.creditAssistance.mockImplementation(async (_id, credit) => {
      await retirement.promise;
      return credit;
    });
    let done = false;
    const finished = installation.finish().then(() => { done = true; });
    await vi.waitFor(() => expect(agent.creditAssistance).toHaveBeenCalledTimes(7));
    expect(done).toBe(false);
    expect(() => owner.assertIdle()).toThrow("installation");
    retirement.resolve(undefined);
    await finished;
    expect(agent.creditAssistance.mock.calls.slice(6).map(([, credit]) => credit)).toEqual(
      grants.map(credit => ({ ...credit, kind: "return" })),
    );
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { retirement.resolve(undefined); await close(); }
});


it("cancels between guest grants and returns the accepted grant before retry", async () => {
  const { owner, agent, close } = fixture();
  const cancellation = new AbortController();
  agent.creditAssistance.mockImplementation((_id, credit) => {
    if (credit.kind === "grant") cancellation.abort();
    return Promise.resolve(credit);
  });
  try {
    await expect(owner.beginInstallation(policy, cancellation.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(agent.creditAssistance.mock.calls.map(([, credit]) => [credit.kind, credit.pool])).toEqual([
      ["grant", "data"], ["return", "data"],
    ]);
    expect(() => owner.assertIdle()).not.toThrow();
    agent.creditAssistance.mockImplementation((_id, credit) => Promise.resolve(credit));
    const retry = await owner.beginInstallation(policy);
    await retry.finish();
  } finally { await close(); }
});

it.each(["finish", "retireWriters"] as const)("fences installation when %s cannot confirm credit retirement", async method => {
  const returned = vi.spyOn(AssistanceTraffic.prototype, "retireGrants");
  const { owner, agent, close } = fixture();
  try {
    const installation = await owner.beginInstallation(policy);
    agent.creditAssistance.mockRejectedValue(new Error("guest retirement is uncertain"));
    await expect(installation[method]()).rejects.toThrow("uncertain");
    await expect(installation.finish()).rejects.toThrow("uncertain");
    await expect(owner.beginInstallation(policy)).rejects.toBeDefined();
    await expect(owner.dispose()).rejects.toBeDefined();
    expect(agent.superviseAssistance.mock.calls.at(-1)?.[1].operation).toBe("abort");
    expect(returned).toHaveBeenCalledWith({ session: installation.identity.session, generation: installation.identity.generation }, null, "installation");
    expect(returned).toHaveBeenCalledWith({ session: installation.identity.session, generation: installation.identity.generation }, null, "installation-gateway");
    expect(returned).toHaveBeenCalledWith({ session: installation.identity.session, generation: installation.identity.generation }, null, "installation-process");
  } finally { returned.mockRestore(); await close(); }
});

/** Unit fixture for the native pipe only; registry framing and fetch remain real owners. */
function gatewayFixture() {
  let client: RegistryClient | undefined;
  let pipe: ReturnType<typeof registryBytePipe> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let replies: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;
  const agent: Pick<GuestAgent, "startInstallation" | "installation"> = {
    startInstallation(_id, bootstrap) {
      stopped = false;
      const { session, generation, installation, sequence } = bootstrap.request;
      const binding = { session, generation, installation };
      const traffic = new GrantedTraffic({ session, generation, process: null, producer: "installation-gateway" },
        bootstrap.credits.filter(credit => credit.producer === "installation-gateway"), 6);
      let requests: ReadableStreamDefaultController<Uint8Array> | undefined;
      reader = new ReadableStream<Uint8Array>({ start(controller) { requests = controller; } }, { highWaterMark: 0 }).getReader();
      pipe = registryBytePipe(new ReadableStream<Uint8Array>({ start(controller) { replies = controller; } }),
        new WritableStream<Uint8Array>({ write(bytes) {
          if (!stopped) requests?.enqueue(bytes);
        } }), traffic);
      client = new RegistryClient(pipe, binding, traffic, bootstrap.credits.filter(credit => credit.producer === "network"),
        () => {}, () => {});
      return Promise.resolve({ ...binding, sequence, result: { kind: "ready", port: 23456 } });
    },
    async installation(_id, request): Promise<InstallationReply> {
      const { session, generation, installation, sequence, operation } = request;
      const identity = { session, generation, installation, sequence };
      switch (operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
        case "acknowledge": return { ...identity, result: { kind: "acknowledged" } };
        case "retire": case "stop":
          stopped = true;
          await reader?.cancel();
          pipe?.close(); await pipe?.done;
          return { ...identity, result: { kind: operation.kind === "retire" ? "retired" : "stopped" } };
        case "read": {
          const data = await reader?.read();
          return { ...identity, result: stopped ? { kind: "error", errno: 125 }
            : { kind: "data", bytes: data?.value ?? new Uint8Array() } };
        }
        case "write":
          if (!stopped) replies?.enqueue(operation.bytes);
          return { ...identity, result: { kind: "written", count: operation.bytes.length } };
        case "start": throw new Error("Bootstrap must use startInstallation");
        case "workspace-capture": case "workspace-capture-read": case "workspace-capture-retire": case "capture": case "capture-read": case "capture-retire": case "materialize": case "activate-materialized": case "execute": case "stdin": case "close-stdin": case "signal": case "output-ack":
          throw new Error("Registry transport fixture does not execute installation processes");
      }
    },
  };
  return { agent, client() { if (client === undefined) throw new Error("Gateway not started"); return client; } };
}

it("rejects invalid guest launch options before acquiring installation authority", async () => {
  const { owner, agent, close } = fixture();
  try {
    await expect(owner.beginInstallation(policy, undefined, { cwd: "/workspace/../etc", frozenLockfile: true }))
      .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(agent.superviseAssistance).not.toHaveBeenCalled();
    expect(agent.creditAssistance).not.toHaveBeenCalled();
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it("retires guest startup failure before returning grants and fencing admission", async () => {
  const { owner, agent, close } = fixture();
  const native = vi.spyOn(agent, "startInstallation").mockImplementation((_id, bootstrap) => Promise.resolve({
    session: bootstrap.request.session, generation: bootstrap.request.generation,
    installation: bootstrap.request.installation, sequence: bootstrap.request.sequence,
    result: { kind: "error", errno: 13 },
  }));
  const stop = vi.spyOn(agent, "installation");
  try {
    await expect(owner.beginInstallation(policy)).rejects.toMatchObject({ code: "RELAY_ERROR", message: "Guest installation gateway did not start" });
    expect(native).toHaveBeenCalledOnce();
    expect(stop.mock.calls.map(([, request]) => request.operation.kind)).toEqual(["stop"]);
    expect(agent.creditAssistance.mock.calls.map(([, credit]) => credit.kind)).toEqual([
      "grant", "grant", "grant", "grant", "grant", "grant",
      "return", "return", "return", "return", "return", "return",
    ]);
    await expect(owner.beginInstallation(policy)).rejects.toBeDefined();
  } finally { await close(); }
});

it("waits for pending guest startup before stopping a cancelled installation", async () => {
  const { owner, agent, close } = fixture();
  const ready = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const launch = agent.startInstallation;
  const native = vi.spyOn(agent, "startInstallation").mockImplementation(async (id, bootstrap) => {
    started.resolve(undefined);
    await ready.promise;
    return launch(id, bootstrap);
  });
  const io = vi.spyOn(agent, "installation");
  const cancellation = new AbortController();
  const opening = owner.beginInstallation(policy, cancellation.signal, { cwd: "/workspace/app", frozenLockfile: false });
  const rejected = expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  try {
    await started.promise;
    cancellation.abort();
    expect(io).not.toHaveBeenCalled();
    expect(agent.creditAssistance.mock.calls.every(([, credit]) => credit.kind === "grant")).toBe(true);
    expect(() => owner.assertIdle()).toThrow("installation");
    ready.resolve(undefined);
    await rejected;
    expect(native.mock.calls[0]?.[1].request.operation).toEqual({ kind: "start", cwd: "/workspace/app", frozenLockfile: false });
    expect(io.mock.calls.map(([, request]) => request.operation.kind)).toEqual(["stop"]);
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { ready.resolve(undefined); await rejected; await close(); }
});

it("streams concurrent registry requests while the full installer grant remains reserved", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => {
    let sent = false;
    return Promise.resolve(new Response(new ReadableStream({ type: "bytes", pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new Uint8Array([1, 2, 3])); }
      else { controller.close(); controller.byobRequest?.respond(0); }
    } })));
  }));
  const { owner, agent, guest, close } = fixture();
  try {
    const installation = await owner.beginInstallation(policy);
    // The native gateway admits four concurrent connections.
    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const headers = await guest.client().start(`${policy.origin}/package-${index}`).response;
      expect(headers.value.status).toBe(200);
      headers.acknowledge();
      let bytes = 0;
      for (;;) {
        const chunk = await guest.client().read(headers.value.request);
        bytes += chunk.value.bytes.length;
        chunk.acknowledge();
        if (chunk.value.done) break;
      }
      expect(bytes).toBe(3);
    }));
    expect(agent.creditAssistance.mock.calls.filter(([, credit]) => credit.kind === "return")).toHaveLength(0);
    await installation.finish();
    expect(agent.creditAssistance.mock.calls.filter(([, credit]) => credit.kind === "return")).toHaveLength(6);
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it("connects installer events and streams under the registry lease without replacing actual exit", async () => {
  const { owner, agent, close } = fixture();
  const native = agent.installation;
  const requests = vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    if (request.operation.kind === "execute") {
      const receive = agent.setInstallationEvents.mock.calls.at(-1)?.[1];
      if (receive === undefined) throw new Error("Installer events were not attached before Execute");
      const binding = { session: request.session, generation: request.generation, installation: request.installation };
      receive({ ...binding, sequence: 1, event: { kind: "output", child: 1, stream: "stdout", bytes: new Uint8Array([7]) } });
      receive({ ...binding, sequence: 2, event: { kind: "eof", child: 1, stream: "stdout" } });
      receive({ ...binding, sequence: 3, event: { kind: "eof", child: 1, stream: "stderr" } });
      receive({ ...binding, sequence: 4, event: { kind: "exit", child: 1, code: 37, signal: null } });
      return Promise.resolve({ ...binding, sequence: request.sequence, result: { kind: "spawned", child: 1, pid: 42 } });
    }
    if (request.operation.kind === "output-ack") return Promise.resolve({ ...request, result: { kind: "unit" } });
    return native(id, request);
  });
  try {
    const installation = await owner.beginInstallation(policy);
    const process = await installation.startProcess();
    await expect(process.exit).resolves.toEqual({ code: 37 });
    const materializing = installation.materialize();
    const rejected = expect(materializing).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { exitCode: 37 } });
    let settled = false;
    void materializing.catch(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(() => owner.assertIdle()).toThrow("installation");
    await expect(installation.startProcess()).rejects.toThrow("already consumed");
    const reader = process.stdout.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([7]));
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    await rejected;
    expect(requests.mock.calls.some(([, request]) => request.operation.kind === "output-ack")).toBe(true);
    await process.kill();
    expect(agent.setInstallationEvents).toHaveBeenLastCalledWith(undefined);
    expect(() => owner.assertIdle()).not.toThrow();
    await expect(process.exit).resolves.toEqual({ code: 37 });
    expect(agent.creditAssistance.mock.calls.filter(([, credit]) => credit.kind === "return")).toHaveLength(6);
  } finally { await close(); }
});

it("waits for running installer exit before closing its channel and releasing admission", async () => {
  const { owner, agent, close } = fixture();
  const native = agent.installation;
  const signalled = Promise.withResolvers<undefined>();
  const requests = vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    if (request.operation.kind === "execute") return Promise.resolve({ ...request, result: { kind: "spawned", child: 1, pid: 42 } });
    if (request.operation.kind === "signal") {
      expect(request.operation).toEqual({ kind: "signal", child: 1, signal: 9 });
      signalled.resolve(undefined);
      return Promise.resolve({ ...request, result: { kind: "unit" } });
    }
    return native(id, request);
  });
  try {
    const installation = await owner.beginInstallation(policy);
    const process = await installation.startProcess();
    const receive = agent.setInstallationEvents.mock.calls.at(-1)?.[1];
    if (receive === undefined) throw new Error("Missing installer event receiver");
    const finishing = installation.finish();
    void finishing.catch(() => {});
    await Promise.race([signalled.promise, finishing]);
    expect(requests.mock.calls.some(([, request]) => request.operation.kind === "signal")).toBe(true);
    expect(requests.mock.calls.some(([, request]) => request.operation.kind === "stop")).toBe(false);
    expect(() => owner.assertIdle()).toThrow("installation");
    const writer = process.stdin.getWriter();
    await expect(writer.write(new Uint8Array([1]))).rejects.toMatchObject({ code: "ABORTED" });
    writer.releaseLock();
    receive({ ...installation.identity, sequence: 1, event: { kind: "exit", child: 1, code: null, signal: 9 } });
    await finishing;
    await expect(process.exit).resolves.toEqual({ code: null, signal: "SIGKILL" });
    expect(agent.setInstallationEvents).toHaveBeenLastCalledWith(undefined);
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it("cancels installer startup through the existing Stop path before returning its lease", async () => {
  const { owner, agent, close } = fixture();
  const cancellation = new AbortController();
  const entered = Promise.withResolvers<Parameters<GuestAgent["installation"]>[1]>();
  const executing = Promise.withResolvers<InstallationReply>();
  const native = agent.installation;
  vi.spyOn(agent, "installation").mockImplementation(async (id, request) => {
    if (request.operation.kind === "execute") { entered.resolve(request); return executing.promise; }
    if (request.operation.kind === "stop") {
      const execute = await entered.promise;
      executing.resolve({ ...execute, result: { kind: "error", errno: 125 } });
    }
    return native(id, request);
  });
  try {
    const installation = await owner.beginInstallation(policy, cancellation.signal);
    const starting = installation.startProcess();
    const rejected = expect(starting).rejects.toMatchObject({ code: "ABORTED" });
    await entered.promise;
    cancellation.abort();
    await installation.finish();
    await rejected;
    expect(() => owner.assertIdle()).not.toThrow();
    expect(agent.setInstallationEvents).toHaveBeenLastCalledWith(undefined);
    expect(agent.creditAssistance.mock.calls.filter(([, credit]) => credit.kind === "return")).toHaveLength(6);
  } finally { await close(); }
});

it("retires writers once while retaining publication admission and cancellation", async () => {
  const { owner, agent, close } = fixture();
  const requests = vi.spyOn(agent, "installation");
  const cancellation = new AbortController();
  try {
    const installation = await owner.beginInstallation(policy, cancellation.signal);
    const retiring = installation.retireWriters();
    expect(installation.retireWriters()).toBe(retiring);
    await retiring;
    expect(installation.signal.aborted).toBe(false);
    expect(() => owner.assertIdle()).toThrow("installation");
    await expect(owner.beginInstallation(policy)).rejects.toThrow("installation");
    await expect(owner.prepareBound()).rejects.toThrow("installation");
    await expect(installation.startProcess()).rejects.toMatchObject({ code: "ABORTED" });
    expect(requests.mock.calls.filter(([, request]) => request.operation.kind === "retire")).toHaveLength(1);
    expect(requests.mock.calls.filter(([, request]) => request.operation.kind === "stop")).toHaveLength(0);
    expect(agent.creditAssistance.mock.calls.filter(([, credit]) => credit.kind === "return")).toHaveLength(5);
    cancellation.abort();
    expect(installation.signal.aborted).toBe(true);
    expect(() => owner.assertIdle()).toThrow("installation");
    const completion = installation.finish();
    expect(installation.finish()).toBe(completion);
    await completion;
    expect(() => owner.assertIdle()).not.toThrow();
    expect(requests.mock.calls.filter(([, request]) => request.operation.kind === "stop")).toHaveLength(1);
    expect(agent.creditAssistance.mock.calls.filter(([, credit]) => credit.kind === "return")).toHaveLength(6);
  } finally { await close(); }
});

it("grants all publication windows before starting any capture and retains the lease", async () => {
  const { owner, agent, close } = fixture();
  const original = agent.installation.bind(agent);
  const starts: string[] = [];
  vi.spyOn(agent, "installation").mockImplementation((_id, request) => {
    const operation = request.operation;
    const complete = (result: InstallationReply["result"]): Promise<InstallationReply> => Promise.resolve({
      session: request.session, generation: request.generation, installation: request.installation, sequence: request.sequence, result,
    });
    switch (operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "execute": return Promise.resolve(installerExit(agent, request));
      case "materialize": return complete({ kind: "materialized" });
      case "activate-materialized": return complete({ kind: "unit" });
      case "capture": case "workspace-capture": {
        const grants = agent.creditAssistance.mock.calls.map(([, credit]) => credit).filter(credit => credit.producer === "storage");
        expect(grants.map(credit => [credit.pool, credit.bytes, credit.entries])).toEqual([
          ["data", 3 * 1024 * 1024, 6], ["control", 3 * 16 * 1024, 6],
        ]);
        starts.push(operation.kind === "workspace-capture" ? operation.source : "dependencies");
        return complete({ kind: "capture-ready", bytes: 0 });
      }
      case "capture-retire": case "workspace-capture-retire": return complete({ kind: "capture-retired", errno: 125 });
      case "start": case "stop": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "retire": case "acknowledge": case "workspace-capture-read": case "output-ack": case "capture-read": return original(_id, request);
    }
  });
  try {
    const installation = await owner.beginInstallation(policy);
    await installation.startProcess();
    await Promise.all([installation.capture(), installation.capture("snapshot"), installation.capture("delta")]);
    expect(starts).toEqual(["dependencies", "snapshot", "delta"]);
    expect(() => owner.assertIdle()).toThrow("installation");
    await installation.finish();
    expect(() => owner.assertIdle()).not.toThrow();
    expect(agent.creditAssistance.mock.calls.map(([, credit]) => credit).filter(credit => credit.producer === "storage").map(credit => credit.kind))
      .toEqual(["grant", "grant", "return", "return"]);
  } finally { await close(); }
});

it.each(["confirmed", "activated", "activation-failure", "lost", "allocation", "committed-cleanup", "missing-generation"])("retains publication ownership through %s completion", async outcome => {
  const { owner, agent, close } = fixture();
  const original = agent.installation.bind(agent);
  const requests = vi.spyOn(agent, "installation").mockImplementation((_id, request) => {
    const result = (result: InstallationReply["result"]): Promise<InstallationReply> => Promise.resolve({
      session: request.session, generation: request.generation, installation: request.installation, sequence: request.sequence, result,
    });
    switch (request.operation.kind) {
      case "set-build-policy": case "blocked-builds": case "validate-inputs": case "check-current": throw new Error("v6 fixture cannot validate inputs");
      case "execute": return Promise.resolve(installerExit(agent, request));
      case "materialize": return result({ kind: "materialized" });
      case "activate-materialized": return outcome === "activation-failure" ? result({ kind: "error", errno: 116 }) : result({ kind: "unit" });
      case "capture": case "workspace-capture": return result({ kind: "capture-ready", bytes: 0 });
      case "capture-read": case "workspace-capture-read": return result({ kind: "data", bytes: new Uint8Array() });
      case "capture-retire": case "workspace-capture-retire": return result({ kind: "capture-retired", errno: 0 });
      case "start": case "stop": case "read": case "write": case "stdin": case "close-stdin": case "signal": case "retire": case "acknowledge": case "output-ack": return original(_id, request);
    }
  });
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const store = new WorkspaceStore({
    async *list(prefix) { for (const path of files.keys()) if (path.startsWith(prefix)) yield await Promise.resolve(path); },
    read: path => Promise.resolve(files.get(path)),
    write: (path, bytes) => { files.set(path, bytes.slice()); return Promise.resolve(); },
    remove: path => { files.delete(path); return Promise.resolve(); },
  });
  const committed = Promise.withResolvers<undefined>();
  const deliver = Promise.withResolvers<undefined>();
  const channel = new MessageChannel();
  const publications = new WorkspacePublications();
  const server = serveSnapshotStorage(channel.port1, async (request, signal) => {
    if (request.type === "stage-workspace-streams") return publications.stage(store, request.publication, signal);
    if (request.type === "retire-workspace-source") return publications.retireReadSource(request.identity, request.source);
    const result = request.type === "finish-workspace-stage" ? await publications.finishStage(request.identity, request.decision)
      : request.type === "commit-workspace-streams" ? await publications.commit(store, request.publication, signal)
      : (() => { throw new Error("unexpected request"); })();
    committed.resolve(undefined);
    await deliver.promise;
    if (outcome === "lost") throw new Error("reply lost after commitment");
    if (outcome === "missing-generation") {
      const missing: WorkspacePublicationResult = { ...result, outcome: { kind: "committed", generation: 1 } };
      return missing;
    }
    if (outcome === "committed-cleanup") {
      const failed: WorkspacePublicationResult = { ...result, outcome: { kind: "failed", error: {
        code: "STORAGE_ERROR", message: "cleanup failed after commitment", detail: { committed: true, cleanupFailed: true },
      } } };
      return failed;
    }
    return result;
  });
  const storage = new SnapshotStorageClient(channel.port2);
  try {
    const installation = await owner.beginInstallation(policy);
    await installation.startProcess();
    if (outcome === "allocation") {
      const transfer = workspaceTransfers.transferWorkspaceStream;
      let allocations = 0;
      const fault = vi.spyOn(workspaceTransfers, "transferWorkspaceStream").mockImplementation((...arguments_) => {
        if (++allocations === 3) throw new VMError("QUOTA_EXCEEDED", "transfer allocation failed");
        return transfer(...arguments_);
      });
      try {
        await expect(installation.publish(storage, { workspaceBaseSha256: "a".repeat(64), inputsSha256: "b".repeat(64) })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
        await installation.finish();
        expect(() => owner.assertIdle()).not.toThrow();
      } finally { fault.mockRestore(); }
      return;
    }
    const activations = () => requests.mock.calls.filter(([, request]) => request.operation.kind === "activate-materialized").length;
    const pending = installation.publish(storage, { workspaceBaseSha256: "a".repeat(64), inputsSha256: "b".repeat(64) },
      outcome === "activated" || outcome === "activation-failure" ? { agent: { cancel: vi.fn() }, requestId: 42 } : undefined);
    await Promise.race([committed.promise, pending.then(() => { throw new Error("publication replied before barrier"); })]);
    const finishing = installation.finish();
    let finished = false;
    void finishing.then(() => { finished = true; }, () => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(() => owner.assertIdle()).toThrow("installation");
    deliver.resolve(undefined);
    if (outcome === "confirmed" || outcome === "activated") {
      const result = await pending;
      expect(result.outcome).toMatchObject({ kind: "committed", generation: 1 });
      await finishing;
      expect(activations()).toBe(outcome === "activated" ? 1 : 0);
      expect(() => owner.assertIdle()).not.toThrow();
    } else if (outcome === "activation-failure") {
      await expect(pending).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { activationUncertain: true } });
      await expect(finishing).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { activationUncertain: true } });
      expect(files.has("active.json")).toBe(false);
      await expect(owner.beginInstallation(policy)).rejects.toBeDefined();
    } else if (outcome === "missing-generation") {
      await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR", detail: { committed: true } });
      await expect(finishing).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { committed: true, cleanupFailed: true } });
      await expect(owner.beginInstallation(policy)).rejects.toBeDefined();
    } else if (outcome === "committed-cleanup") {
      await expect(pending).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { committed: true } });
      await expect(finishing).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { committed: true, cleanupFailed: true } });
      await expect(owner.beginInstallation(policy)).rejects.toBeDefined();
    } else {
      await expect(pending).rejects.toThrow("reply lost");
      await expect(finishing).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { cleanupFailed: true } });
      await expect(owner.beginInstallation(policy)).rejects.toBeDefined();
    }
  } finally { deliver.resolve(undefined); storage.close(); await server.close(); await close(); }
});


it("rejects dependency materialization before an installer has started", async () => {
  const { owner, close } = fixture();
  try {
    const installation = await owner.beginInstallation(policy);
    await expect(installation.materialize()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await installation.finish();
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});


function installerExit(agent: ReturnType<typeof fixture>["agent"], request: Parameters<GuestAgent["installation"]>[1], code = 0): InstallationReply {
  const receive = agent.setInstallationEvents.mock.calls.at(-1)?.[1];
  if (receive === undefined) throw new Error("Installer events missing");
  const binding = { session: request.session, generation: request.generation, installation: request.installation };
  receive({ ...binding, sequence: 1, event: { kind: "eof", child: 1, stream: "stdout" } });
  receive({ ...binding, sequence: 2, event: { kind: "eof", child: 1, stream: "stderr" } });
  receive({ ...binding, sequence: 3, event: { kind: "exit", child: 1, code, signal: null } });
  return { ...binding, sequence: request.sequence, result: { kind: "spawned", child: 1, pid: 42 } };
}

it.each([false, true])("waits for native exit before materialization (cancelled=%s)", async cancelled => {
  const { owner, agent, close } = fixture();
  const cancellation = new AbortController();
  const native = agent.installation;
  const requests = vi.spyOn(agent, "installation").mockImplementation((id, request) => request.operation.kind === "execute"
    ? Promise.resolve({ session: request.session, generation: request.generation, installation: request.installation,
      sequence: request.sequence, result: { kind: "spawned", child: 1, pid: 42 } })
    : request.operation.kind === "materialize" ? Promise.resolve({ ...request, result: { kind: "materialized" } })
    : request.operation.kind === "signal" ? Promise.resolve({ ...request, result: { kind: "unit" } }) : native(id, request));
  try {
    const installation = await owner.beginInstallation(policy, cancellation.signal);
    const process = await installation.startProcess();
    const pending = installation.materialize();
    await Promise.resolve();
    expect(requests.mock.calls.some(([, request]) => request.operation.kind === "retire" || request.operation.kind === "materialize")).toBe(false);
    if (cancelled) {
      cancellation.abort();
      await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    }
    const receive = agent.setInstallationEvents.mock.calls.at(-1)?.[1];
    if (receive === undefined) throw new Error("Missing native exit receiver");
    receive({ ...installation.identity, sequence: 1, event: { kind: "eof", child: 1, stream: "stdout" } });
    receive({ ...installation.identity, sequence: 2, event: { kind: "eof", child: 1, stream: "stderr" } });
    receive({ ...installation.identity, sequence: 3, event: { kind: "exit", child: 1, code: cancelled ? 37 : 0, signal: null } });
    if (!cancelled) await pending;
    await installation.finish();
    await expect(process.exit).resolves.toEqual({ code: cancelled ? 37 : 0 });
    expect(requests.mock.calls.some(([, request]) => request.operation.kind === "materialize")).toBe(!cancelled);
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it.each(["read", "discard", "abort"] as const)("keeps preparation output alive until %s", async action => {
  const { owner, agent, close } = fixture();
  const cancellation = new AbortController();
  const native = agent.installation;
  const requests = vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    const result = (result: InstallationReply["result"]) => Promise.resolve({ ...request, result });
    if (request.operation.kind === "execute") return result({ kind: "spawned", child: 1, pid: 42 });
    if (request.operation.kind === "materialize") return result({ kind: "materialized" });
    if (request.operation.kind === "output-ack") return result({ kind: "unit" });
    return native(id, request);
  });
  try {
    const installation = await owner.beginInstallation(policy, cancellation.signal);
    const process = await installation.startProcess();
    const receive = agent.setInstallationEvents.mock.calls.at(-1)?.[1];
    if (receive === undefined) throw new Error("Missing installer event receiver");
    receive({ ...installation.identity, sequence: 1, event: { kind: "output", child: 1, stream: "stderr", bytes: new Uint8Array([8]) } });
    receive({ ...installation.identity, sequence: 2, event: { kind: "exit", child: 1, code: 0, signal: null } });
    receive({ ...installation.identity, sequence: 3, event: { kind: "eof", child: 1, stream: "stdout" } });
    receive({ ...installation.identity, sequence: 4, event: { kind: "eof", child: 1, stream: "stderr" } });
    const pending = installation.materialize();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(requests.mock.calls.some(([, request]) => request.operation.kind === "retire")).toBe(false);
    if (action === "abort") {
      cancellation.abort();
      await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    } else {
      if (action === "discard") await process.stderr.cancel();
      else {
        const reader = process.stderr.getReader();
        expect((await reader.read()).value).toEqual(new Uint8Array([8]));
        expect((await reader.read()).done).toBe(true);
        reader.releaseLock();
      }
      await pending;
      expect(await process.stdout.getReader().read()).toEqual({ done: true, value: undefined });
    }
    await installation.finish();
    await expect(process.exit).resolves.toEqual({ code: 0 });
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it.each([false, true])("validates guest-v7 inputs before writer retirement (stale=%s)", async stale => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  const original = agent.installation;
  const operations: string[] = [];
  vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    operations.push(request.operation.kind);
    const result = (result: InstallationReply["result"]) => Promise.resolve({ ...request, result });
    if (request.operation.kind === "set-build-policy") return Promise.resolve({ ...request, result: { kind: "unit" } });
    if (request.operation.kind === "check-current") return Promise.resolve({ ...request, result: { kind: "error", errno: 2 } });
    if (request.operation.kind === "execute") return Promise.resolve(installerExit(agent, request));
    if (request.operation.kind === "validate-inputs") return result(stale ? { kind: "error", errno: 116 } : { kind: "data", bytes: new Uint8Array(64).fill(0xab) });
    if (request.operation.kind === "materialize") return result({ kind: "materialized" });
    return original(id, request);
  });
  try {
    const installation = await owner.beginInstallation(policy);
    const process = await installation.startProcess();
    expect(() => installation.inputsSha256).toThrow();
    if (stale) {
      await expect(installation.materialize()).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { errno: 116 } });
      expect(operations).not.toContain("retire");
      expect(operations).not.toContain("materialize");
    } else {
      await installation.materialize();
      expect(installation.inputsSha256).toBe("ab".repeat(32));
      expect(operations.indexOf("validate-inputs")).toBeLessThan(operations.indexOf("retire"));
      expect(operations.indexOf("retire")).toBeLessThan(operations.indexOf("materialize"));
    }
    await expect(process.exit).resolves.toEqual({ code: 0 });
    await installation.finish();
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it("cancels native validation through enclosing retirement without replacing pnpm exit", async () => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  const original = agent.installation;
  const validation = Promise.withResolvers<InstallationReply>();
  const started = Promise.withResolvers<undefined>();
  const cancellation = new AbortController();
  let request: Parameters<GuestAgent["installation"]>[1] | undefined;
  vi.spyOn(agent, "installation").mockImplementation((id, incoming) => {
    if (incoming.operation.kind === "execute") return Promise.resolve(installerExit(agent, incoming));
    if (incoming.operation.kind === "validate-inputs") { request = incoming; started.resolve(undefined); return validation.promise; }
    if (incoming.operation.kind === "stop" && request !== undefined) validation.resolve({ ...request, result: { kind: "error", errno: 125 } });
    return original(id, incoming);
  });
  try {
    const installation = await owner.beginInstallation(policy, cancellation.signal);
    const process = await installation.startProcess();
    const pending = installation.materialize();
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await started.promise;
    cancellation.abort();
    await rejected;
    await installation.finish();
    await expect(process.exit).resolves.toEqual({ code: 0 });
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it.each(["committed", "failed"])("preparation handle separates pnpm exit from %s generation retirement", async outcome => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  const original = agent.installation;
  const retiring = Promise.withResolvers<undefined>();
  const retire = Promise.withResolvers<undefined>();
  vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    if (request.operation.kind === "set-build-policy") return Promise.resolve({ ...request, result: { kind: "unit" } });
    if (request.operation.kind === "check-current") return Promise.resolve({ ...request, result: { kind: "error", errno: 2 } });
    if (request.operation.kind === "execute") return Promise.resolve(installerExit(agent, request));
    if (request.operation.kind === "validate-inputs") return Promise.resolve({ ...request,
      result: { kind: "data", bytes: new Uint8Array(64).fill(0xab) } });
    if (request.operation.kind === "materialize") return Promise.resolve({ ...request, result: { kind: "materialized" } });
    if (request.operation.kind === "stop") {
      retiring.resolve(undefined);
      return retire.promise.then(() => original(id, request));
    }
    return original(id, request);
  });
  const channel = new MessageChannel();
  const storage = new SnapshotStorageClient(channel.port1);
  const publication = Promise.withResolvers<WorkspacePublicationResult>();
  vi.spyOn(storage, "readBuildPolicy").mockResolvedValue([]);
  try {
    const installation = await owner.beginInstallation(policy);
    const publish = vi.spyOn(installation, "publish").mockReturnValue(publication.promise);
    const activation = { requestId: 42, agent: { cancel: vi.fn() } };
    const handle = await installation.prepare(storage, "a".repeat(64), activation);
    const generation = handle.generation.then(value => ({ value }), (error: unknown) => ({ error }));
    await expect(installation.prepare(storage, "a".repeat(64), activation)).rejects.toThrow("already started");
    await expect(handle.exit).resolves.toEqual({ code: 0 });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(storage,
      { workspaceBaseSha256: "a".repeat(64), inputsSha256: "ab".repeat(32) }, activation));
    expect(() => owner.assertIdle()).toThrow("installation");
    publication.resolve(outcome === "committed" ? { retired: true,
      credit: { ...installation.identity, sequence: 1, kind: "return", producer: "storage", process: null,
        pool: "data", reservation: 1, bytes: 8 * 1024 * 1024, entries: 1 },
      outcome: { kind: "committed", generation: 1, dependencyGeneration: "c".repeat(64) },
    } : { retired: false, outcome: { kind: "failed", error: { code: "STORAGE_ERROR", message: "publication failed" } } });
    await retiring.promise;
    let completed = false;
    void generation.then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    expect(() => owner.assertIdle()).toThrow("installation");
    retire.resolve(undefined);
    expect(await generation).toMatchObject(outcome === "committed" ? { value: "c".repeat(64) } : { error: { code: "STORAGE_ERROR" } });
    await expect(handle.exit).resolves.toEqual({ code: 0 });
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { retire.resolve(undefined); storage.close(); channel.port2.close(); await close(); }
});


it("cancels preparation by its control request identity while preserving another request", async () => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  const channel = new MessageChannel();
  const storage = new SnapshotStorageClient(channel.port1);
  const original = agent.installation;
  vi.spyOn(storage, "readBuildPolicy").mockResolvedValue([]);
  const started = Promise.withResolvers<undefined>();
  const execute = Promise.withResolvers<InstallationReply>();
  let pending: Parameters<GuestAgent["installation"]>[1] | undefined;
  const requests = vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    if (request.operation.kind === "set-build-policy") return Promise.resolve({ ...request, result: { kind: "unit" } });
    if (request.operation.kind === "check-current") return Promise.resolve({ ...request, result: { kind: "error", errno: 2 } });
    if (request.operation.kind === "execute") { pending = request; started.resolve(undefined); return execute.promise; }
    if (request.operation.kind === "stop" && pending !== undefined) execute.resolve({ ...pending, result: { kind: "error", errno: 125 } });
    return original(id, request);
  });
  try {
    const preparing = owner.prepareDependencies(42, policy, { storage, workspaceBaseSha256: "a".repeat(64),
      agent: { cancel: vi.fn() } });
    const rejected = expect(preparing).rejects.toMatchObject({ code: "ABORTED" });
    await started.promise;
    owner.cancel(41);
    expect(requests.mock.calls.some(([, request]) => request.operation.kind === "stop")).toBe(false);
    owner.cancel(42);
    await rejected;
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { storage.close(); channel.port2.close(); await close(); }
});

it.each(["legacy", "request", "base"])("rejects %s preparation before guest admission", async invalid => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), invalid === "legacy" ? 6 : 7);
  const starting = vi.spyOn(agent, "startInstallation");
  const channel = new MessageChannel();
  const storage = new SnapshotStorageClient(channel.port1);
  try {
    await expect(owner.prepareDependencies(invalid === "request" ? 0 : 42, policy,
      { storage, workspaceBaseSha256: invalid === "base" ? "wrong" : "a".repeat(64),
        agent: { cancel: vi.fn() } }))
      .rejects.toMatchObject({ code: invalid === "legacy" ? "FEATURE_NOT_AVAILABLE" : "PROTOCOL_ERROR" });
    expect(agent.superviseAssistance).not.toHaveBeenCalled();
    expect(starting).not.toHaveBeenCalled();
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { storage.close(); channel.port2.close(); await close(); }
});

it("reports scoped blocked builds without publishing or changing the installer exit", async () => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  const native = agent.installation;
  const blockedBuilds = [{ name: "sharp", version: "0.34.5", integrity: "sha512-" + btoa("\0".repeat(64)) }];
  const operations: string[] = [];
  vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    operations.push(request.operation.kind);
    if (request.operation.kind === "execute") return Promise.resolve(installerExit(agent, request, 1));
    if (request.operation.kind === "blocked-builds") return Promise.resolve({ ...request,
      result: { kind: "data", bytes: new TextEncoder().encode(JSON.stringify(blockedBuilds)) } });
    return native(id, request);
  });
  try {
    const installation = await owner.beginInstallation(policy);
    const process = await installation.startProcess();
    await expect(process.exit).resolves.toEqual({ code: 1 });
    await expect(installation.materialize()).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { exitCode: 1, blockedBuilds } });
    expect(operations).toContain("blocked-builds");
    expect(operations).not.toContain("materialize");
    await installation.finish();
    await expect(process.exit).resolves.toEqual({ code: 1 });
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); }
});

it.each(["applied", "storage-failed", "guest-failed"])("transfers persisted policy before starting pnpm: %s", async outcome => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  const channel = new MessageChannel();
  const storage = new SnapshotStorageClient(channel.port1);
  const decisions = [{ name: "sharp", version: "0.34.3", integrity: `sha512-${btoa("a".repeat(64))}`, decision: "allow" as const }];
  const read = vi.spyOn(storage, "readBuildPolicy");
  if (outcome === "storage-failed") read.mockRejectedValue(new VMError("STORAGE_ERROR", "Invalid policy"));
  else read.mockResolvedValue(decisions);
  const original = agent.installation;
  const operations: string[] = [];
  vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    operations.push(request.operation.kind);
    if (request.operation.kind === "check-current") return Promise.resolve({ ...request, result: { kind: "error", errno: 2 } });
    if (request.operation.kind === "set-build-policy") {
      expect(JSON.parse(new TextDecoder().decode(request.operation.bytes))).toEqual(decisions);
      return Promise.resolve({ ...request, result: outcome === "guest-failed" ? { kind: "error", errno: 13 } : { kind: "unit" } });
    }
    if (request.operation.kind === "execute") return Promise.resolve(installerExit(agent, request, 1));
    if (request.operation.kind === "blocked-builds") return Promise.resolve({ ...request, result: { kind: "data", bytes: new TextEncoder().encode("[]") } });
    return original(id, request);
  });
  try {
    const installation = await owner.beginInstallation(policy);
    const preparing = installation.prepare(storage, "a".repeat(64), { requestId: 42,
      agent: { cancel: vi.fn() } });
    if (outcome === "applied") {
      const handle = await preparing;
      await expect(handle.generation).rejects.toMatchObject({ detail: { exitCode: 1 } });
      await expect(handle.exit).resolves.toEqual({ code: 1 });
      expect(operations.indexOf("execute")).toBeGreaterThan(operations.indexOf("set-build-policy"));
      expect(operations.slice(operations.indexOf("set-build-policy"), operations.indexOf("execute"))).toContain("acknowledge");
    } else {
      await expect(preparing).rejects.toBeInstanceOf(VMError);
      expect(operations).not.toContain("execute");
    }
    expect(read).toHaveBeenCalledWith("a".repeat(64), installation.signal);
  } finally { storage.close(); channel.port2.close(); await close(); }
});

it("records installation phases and exposes the latest profile after retirement", async () => {
  const { owner, close } = fixture();
  try {
    const installation = await owner.beginInstallation(policy);
    const connected = installation.profile.snapshot();
    expect(connected.installation).toBe(installation.identity.installation);
    expect(connected.phases.map(phase => phase.name)).toEqual(["connect", "connect:credits", "connect:registry", "connect:streams", "connect:start"]);
    expect(connected.phases[0]?.endedMs).not.toBeNull();
    expect(owner.installationProfile()).toEqual(connected);
    await installation.finish();
    const finished = owner.installationProfile();
    expect(finished?.phases.map(phase => phase.name)).toEqual(["connect", "connect:credits", "connect:registry", "connect:streams", "connect:start", "finish"]);
    expect(finished?.phases[5]?.endedMs).not.toBeNull();
  } finally { await close(); }
});

it("fails a running preparation promptly when guest supervision dies before pnpm exits", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  let dispatcherDead = false;
  agent.superviseAssistance.mockImplementation((_id, request: { operation: string }) => {
    if (request.operation === "bind" || !dispatcherDead) return Promise.resolve();
    return Promise.reject(new VMError("STORAGE_ERROR", "assistance dispatcher failed: ENOBUFS", { agentStatus: 4 }));
  });
  const original = agent.installation;
  vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    // A dead dispatcher answers every later request with an I/O failure.
    if (dispatcherDead) return Promise.reject(new VMError("STORAGE_ERROR", "assistance dispatcher failed: ENOBUFS", { agentStatus: 4 }));
    if (request.operation.kind === "set-build-policy") return Promise.resolve({ ...request, result: { kind: "unit" } });
    if (request.operation.kind === "check-current") return Promise.resolve({ ...request, result: { kind: "error", errno: 2 } });
    if (request.operation.kind === "execute") return Promise.resolve({ session: request.session, generation: request.generation,
      installation: request.installation, sequence: request.sequence, result: { kind: "spawned", child: 1, pid: 42 } });
    return original(id, request);
  });
  const channel = new MessageChannel();
  const storage = new SnapshotStorageClient(channel.port1);
  vi.spyOn(storage, "readBuildPolicy").mockResolvedValue([]);
  try {
    const installation = await owner.beginInstallation(policy);
    const activation = { requestId: 7, agent: { cancel: vi.fn() } };
    const handle = await installation.prepare(storage, "a".repeat(64), activation);
    const generation = handle.generation.then(value => ({ value }), (error: unknown) => ({ error }));
    const exit = handle.exit.then(value => ({ value }), (error: unknown) => ({ error }));
    // pnpm never exits: the guest dispatcher died and no further events arrive.
    dispatcherDead = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const settled = await Promise.race([
      Promise.all([generation, exit]).then(() => "settled" as const),
      new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(settled).toBe("settled");
    const outcome = await generation;
    if (!("error" in outcome) || !(outcome.error instanceof VMError)) throw new Error("expected a typed generation failure");
    expect(["GUEST_CRASH", "STORAGE_ERROR", "ABORTED"]).toContain(outcome.error.code);
    expect(() => owner.assertHealthy()).toThrow();
  } finally { vi.useRealTimers(); storage.close(); channel.port2.close(); await close(); }
});

/** A prepare whose inputs and policy still match the activated generation
 * returns that generation without an installer, a capture or a publication:
 * the guest answers the current-generation check with the 64-byte identity. */
it("returns the activated generation without an installer when the guest reports it current", async () => {
  const { owner, agent, close } = fixture(Promise.resolve(undefined), 7);
  const native = agent.installation;
  const identity = new Uint8Array(64);
  for (let index = 0; index < 32; index++) { identity[index] = index + 1; identity[32 + index] = 0xa0 + index; }
  const requests = vi.spyOn(agent, "installation").mockImplementation((id, request) => {
    if (request.operation.kind === "set-build-policy") return Promise.resolve({ ...request, result: { kind: "unit" } });
    if (request.operation.kind === "check-current") return Promise.resolve({ ...request, result: { kind: "data", bytes: identity } });
    if (request.operation.kind === "acknowledge") return Promise.resolve({ ...request, result: { kind: "acknowledged" } });
    return native(id, request);
  });
  const channel = new MessageChannel();
  const storage = new SnapshotStorageClient(channel.port1);
  vi.spyOn(storage, "readBuildPolicy").mockResolvedValue([]);
  try {
    const installation = await owner.beginInstallation(policy, undefined, { cwd: "/workspace/app", frozenLockfile: true });
    const handle = await installation.prepare(storage, "a".repeat(64), { agent: { cancel: vi.fn() }, requestId: 7 });
    await expect(handle.generation).resolves.toBe(Array.from(identity.subarray(0, 32), byte => byte.toString(16).padStart(2, "0")).join(""));
    await expect(handle.exit).resolves.toEqual({ code: 0 });
    expect((await handle.stdout.getReader().read()).done).toBe(true);
    expect(requests.mock.calls.map(([, request]) => request.operation.kind)).not.toContain("execute");
    expect(installation.profile.snapshot().phases.map(phase => phase.name)).toContain("check-current");
    expect(() => owner.assertIdle()).not.toThrow();
  } finally { await close(); channel.port1.close(); channel.port2.close(); }
});
