import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integer, record, string } from "./decode.js";
import { serializeUnknownError, VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import { createUserspaceRuntimeVM } from "./userspace-vm.js";

/** The Userspace worker behind the control worker's `attach-userspace` port: the request types it received, in order. */
const userspace = { received: new Array<string>(), ports: new Array<MessagePort>() };

/** The control worker attaches the Userspace execution; `initialize` answers with `initialized` and `dispose` succeeds. */
function scriptUserspaceWorker(initialized: () => unknown = () => undefined): void {
  ScriptedWorker.answers.set("attach-userspace", input => {
    const port = input["port"];
    if (!(port instanceof MessagePort)) throw new Error("attach-userspace carries no Userspace port");
    userspace.ports.push(port);
    port.onmessage = (event: MessageEvent<unknown>) => {
      const request = record(event.data, "Userspace request"), type = string(request["type"], "Userspace request type");
      const id = integer(request["id"], "Userspace request id", 1);
      userspace.received.push(type);
      try {
        if (type !== "initialize" && type !== "dispose") throw new Error(`unexpected Userspace request ${type}`);
        port.postMessage({ id, version: PROTOCOL_VERSION, ok: true, value: type === "initialize" ? initialized() : undefined });
      } catch (error) { port.postMessage({ id, version: PROTOCOL_VERSION, ok: false, error: serializeUnknownError(error) }); }
    };
    return undefined;
  });
}

/** Lets messages between channels arrive. */
async function arrive(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

const WORKERS = ["oxidevm-storage", "oxidevm-network", "oxidevm-control"] as const;
const start = () => createUserspaceRuntimeVM({ mode: "userspace", workspaceId: "start", memoryMiB: 256, network: "local" });

describe("a Userspace VM start", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://app.example.test/"));
  });
  afterEach(() => {
    for (const port of userspace.ports.splice(0)) port.close();
    userspace.received.length = 0;
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("starts the control worker, which starts the Userspace worker, while storage initializes", async () => {
    const storage = Promise.withResolvers<undefined>();
    ScriptedWorker.answers.set("initialize", () => storage.promise);
    scriptUserspaceWorker();
    const starting = start();
    await arrive();
    // Their scripts load alongside storage's initialize instead of after it.
    expect(ScriptedWorker.named("oxidevm-storage").operations).toEqual(["initialize"]);
    expect(ScriptedWorker.named("oxidevm-control").operations).toEqual(["attach-userspace"]);
    // The Userspace worker receives its storage and network ports only once storage has initialized.
    expect(userspace.received).toEqual([]);
    storage.resolve(undefined);
    const vm = await starting;
    expect(userspace.received).toEqual(["initialize"]);
    await vm.dispose();
    expect(userspace.received).toEqual(["initialize", "dispose"]);
  });

  it("reports a failed storage initialize, not the earlier failure it caused, and ends every worker it started", async () => {
    const storage = Promise.withResolvers<undefined>();
    ScriptedWorker.answers.set("initialize", () => storage.promise);
    ScriptedWorker.answers.set("attach-userspace", () => { throw new VMError("PROTOCOL_ERROR", "the control worker failed"); });
    const failed = expect(start()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await arrive();
    storage.reject(new VMError("STORAGE_ERROR", "the workspace cannot be opened"));
    await failed;
    for (const name of WORKERS) expect(ScriptedWorker.named(name).terminated, name).toBe(true);
    expect(userspace.received).toEqual([]);
  });

  it("ends every worker it started when the Userspace worker cannot initialize", async () => {
    scriptUserspaceWorker(() => { throw new VMError("CORE_LOAD_FAILED", "Userspace Wasm fetch failed"); });
    await expect(start()).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    for (const name of WORKERS) expect(ScriptedWorker.named(name).terminated, name).toBe(true);
    expect(userspace.received).toEqual(["initialize"]);
  });
});
