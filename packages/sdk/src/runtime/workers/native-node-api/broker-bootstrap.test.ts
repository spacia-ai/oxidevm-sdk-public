import { expect, it, vi } from "vitest";

import { JS_PROCESS_PROTOCOL_VERSION, NATIVE_BROKER_PROCESS_VERSION } from "../../js-process/codec.js";
import { record } from "../../decode.js";

for (const beforeSpawn of [false, true]) it(`acknowledges bootstrap and retains compiler failure ${beforeSpawn ? "before" : "after"} spawn`, async () => {
  vi.resetModules();
  const loading = Promise.withResolvers<never>();
  vi.doMock("./compiler-modules.js", () => ({ modules: loading.promise }));
  const scope: { onmessage?: (event: MessageEvent<unknown>) => void } = {};
  const broker = new MessageChannel(), spawn = new MessageChannel();
  const worker = vi.fn();
  vi.stubGlobal("self", scope); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("Worker", worker);
  const next = (port: MessagePort): Promise<unknown> => new Promise(accept => { port.onmessage = (event: MessageEvent<unknown>) => { accept(event.data); }; port.start(); });
  try {
    await import("./broker.worker.js");
    if (scope.onmessage === undefined) throw new Error("Native broker did not install its bootstrap handler");
    const ready = next(broker.port2);
    scope.onmessage(new MessageEvent("message", { data: { version: 1, port: broker.port1, nonce: "bootstrap-fixture" } }));
    expect(await ready).toEqual({ version: 1, type: "native-ready", nonce: "bootstrap-fixture" });
    if (beforeSpawn) { loading.reject(new Error("Fixture compiler download failed")); await new Promise<void>(accept => setImmediate(accept)); }
    const failure = next(spawn.port2);
    broker.port2.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "spawn", pid: 1000, port: spawn.port1 }, [spawn.port1]);
    await new Promise<void>(accept => setImmediate(accept));
    expect(worker).not.toHaveBeenCalled();
    if (!beforeSpawn) loading.reject(new Error("Fixture compiler download failed"));
    expect(await failure).toEqual({ version: NATIVE_BROKER_PROCESS_VERSION, type: "error", message: "Fixture compiler download failed" });
  } finally {
    for (const port of [broker.port1, broker.port2, spawn.port1, spawn.port2]) port.close();
    vi.doUnmock("./compiler-modules.js");
    vi.unstubAllGlobals();
  }
});

const PROGRAM = { kind: "native-node", entry: "/workspace/server.js", source: { kind: "file" }, input: 3, output: 4, context: { kind: "main" },
  profile: { runtime: "node", executable: "/usr/bin/node", runtimeSHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", identity: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], basis: "no-addons", dependencyGeneration: 1n, artifacts: [], moduleSearchPaths: [], requiredCapabilities: 0 } };

/** A bootstrapped broker with one spawned process whose worker this test plays. */
async function spawnedProcess() {
  vi.resetModules();
  const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  vi.doMock("./compiler-modules.js", () => ({ modules: Promise.resolve([empty, empty]) }));
  const scope: { onmessage?: (event: MessageEvent<unknown>) => void } = {};
  const booted: { bootstrap?: unknown } = {};
  class ProcessWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage(value: unknown): void { booted.bootstrap = value; }
    terminate(): void {}
  }
  vi.stubGlobal("self", scope); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("Worker", ProcessWorker);
  await import("./broker.worker.js");
  const broker = new MessageChannel(), connection = new MessageChannel();
  if (scope.onmessage === undefined) throw new Error("Native broker did not install its bootstrap handler");
  scope.onmessage(new MessageEvent("message", { data: { version: 1, port: broker.port1, nonce: "attention-fixture" } }));
  broker.port2.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "spawn", pid: 1000, port: connection.port1 }, [connection.port1]);
  return { broker, connection, booted };
}

it("sends one attention notice for every Linux request it forwards to the execution worker", async () => {
  const { broker, connection, booted } = await spawnedProcess();
  const upstream = new MessageChannel(), notices = new MessageChannel();
  const received: unknown[] = [];
  let noticed = 0;
  notices.port2.onmessage = () => { noticed += 1; }; notices.port2.start();
  upstream.port2.onmessage = (event: MessageEvent<unknown>) => { received.push(event.data); }; upstream.port2.start();
  try {
    await new Promise<void>(accept => setImmediate(accept));
    connection.port2.postMessage({ version: NATIVE_BROKER_PROCESS_VERSION, type: "start", port: upstream.port1, attention: notices.port1,
      value: { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", port: upstream.port1, generation: 1n, id: 1n, program: PROGRAM } }, [upstream.port1, notices.port1]);
    await vi.waitFor(() => expect(booted.bootstrap).toBeDefined());
    const local = record(booted.bootstrap, "native process bootstrap")["port"];
    if (!(local instanceof MessagePort)) throw new Error("The process worker received no service port");
    for (const sequence of [1, 2, 3]) {
      local.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence, sync: false, operation: 79, payload: new Uint8Array() });
    }
    await vi.waitFor(() => expect(received).toHaveLength(3));
    await vi.waitFor(() => expect(noticed).toBe(3));
    local.close();
  } finally {
    for (const port of [broker.port1, broker.port2, connection.port2, upstream.port2, notices.port2]) port.close();
    vi.doUnmock("./compiler-modules.js"); vi.unstubAllGlobals();
  }
});

it("rejects a process launch from a runtime on the previous broker protocol", async () => {
  vi.resetModules();
  vi.doMock("./compiler-modules.js", () => ({ modules: new Promise(() => {}) }));
  const scope: { onmessage?: (event: MessageEvent<unknown>) => void } = {};
  vi.stubGlobal("self", scope); vi.stubGlobal("crossOriginIsolated", true); vi.stubGlobal("Worker", vi.fn());
  const broker = new MessageChannel(), spawn = new MessageChannel();
  try {
    await import("./broker.worker.js");
    if (scope.onmessage === undefined) throw new Error("Native broker did not install its bootstrap handler");
    scope.onmessage(new MessageEvent("message", { data: { version: 1, port: broker.port1, nonce: "stale-fixture" } }));
    const failure = new Promise<unknown>(accept => { spawn.port2.onmessage = (event: MessageEvent<unknown>) => { accept(event.data); }; spawn.port2.start(); });
    broker.port2.postMessage({ version: 1, type: "spawn", pid: 1000, port: spawn.port1 }, [spawn.port1]);
    expect(await failure).toEqual({ version: NATIVE_BROKER_PROCESS_VERSION, type: "error", message: "Invalid native process launch" });
  } finally {
    for (const port of [broker.port1, broker.port2, spawn.port2]) port.close();
    vi.doUnmock("./compiler-modules.js"); vi.unstubAllGlobals();
  }
});
