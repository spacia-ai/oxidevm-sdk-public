import { afterEach, describe, expect, it, vi } from "vitest";
import { UserspaceProcessBackend } from "./userspace-process.js";
import { integer, record } from "./decode.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { createRuntimeVM } from "./index.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import { VMError } from "./errors.js";

class ControlWorker extends EventTarget {
  static instance: ControlWorker | undefined;
  readonly ports: MessagePort[] = [];
  terminated = false;
  constructor() { super(); ControlWorker.instance = this; }
  postMessage(value: unknown): void {
    const input = record(value, "control request");
    const id = integer(input["id"], "request id", 1);
    if (input["type"] === "attach-userspace") {
      const port = input["port"];
      if (!(port instanceof MessagePort)) throw new Error("Missing runtime port");
      this.ports.push(port);
      port.onmessage = (event: MessageEvent<unknown>) => {
        const request = record(event.data, "runtime request");
        if (request["type"] === "initialize") port.postMessage({ version: PROTOCOL_VERSION, id: integer(request["id"], "id", 1), ok: true, value: undefined });
        // The execution worker stays silent on disposal, as a failed worker can.
      };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id, version: PROTOCOL_VERSION, ok: true, value: undefined } })));
    }
  }
  terminate(): void { this.terminated = true; for (const port of this.ports) port.close(); }
}

describe("Userspace backend retirement", () => {
  afterEach(() => { ControlWorker.instance?.terminate(); ControlWorker.instance = undefined; ScriptedWorker.reset(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("bounds a silent execution worker and shares its complete disposal outcome", async () => {
    vi.stubGlobal("Worker", ControlWorker);
    const backend = await UserspaceProcessBackend.create({ wasmUrl: "https://example.test/core.wasm", memoryMiB: 64 });
    vi.useFakeTimers();
    const first = backend.dispose();
    const second = backend.dispose();
    const results = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second).toBe(first);
    expect((await results)[0]).toMatchObject({ status: "rejected" });
    expect((await results)[1]).toEqual((await results)[0]);
    expect(ControlWorker.instance?.terminated).toBe(true);
  });
  it("requires real storage initialization for persistent system files and propagates unavailability", async () => {
    vi.stubGlobal("Worker", ScriptedWorker);
    ScriptedWorker.answers.set("initialize", () => { throw new VMError("FEATURE_NOT_AVAILABLE", "Durable storage is unavailable"); });
    await expect(createRuntimeVM({ mode: "userspace", workspaceId: "example", memoryMiB: 1536, network: "local", initialUser: "root", rootPersistence: "persistent" }))
      .rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    expect(ScriptedWorker.named("oxidevm-storage").operations).toContain("initialize");
  });
});
