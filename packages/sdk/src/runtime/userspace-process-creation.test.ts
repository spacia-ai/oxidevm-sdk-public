import { afterEach, expect, it, vi } from "vitest";
import { UserspaceProcessBackend } from "./userspace-process.js";
import { integer, record } from "./decode.js";
import { PROTOCOL_VERSION } from "./protocol.js";

class CreationWorker extends EventTarget {
  static instance: CreationWorker | undefined;
  readonly admitted = Promise.withResolvers<undefined>();
  readonly ports: MessagePort[] = [];
  alive = 0;
  cancelled = false;
  publish: () => void = () => {};
  constructor() { super(); CreationWorker.instance = this; }
  postMessage(input: unknown): void {
    const request = record(input, "control request"), id = integer(request["id"], "id", 1);
    const port = request["port"];
    if (!(port instanceof MessagePort)) throw new Error("Missing runtime port");
    this.ports.push(port);
    port.onmessage = (event: MessageEvent<unknown>) => {
      const operation = record(event.data, "runtime request");
      if (operation["type"] === "cancel") { this.cancelled = true; return; }
      const requestId = integer(operation["id"], "id", 1);
      const reply = (value: unknown) => port.postMessage({ id: requestId, version: PROTOCOL_VERSION, ok: true, value });
      if (operation["type"] === "spawn-js") {
        const output = operation["port"];
        if (!(output instanceof MessagePort)) throw new Error("Missing process port");
        this.ports.push(output); this.alive++;
        this.publish = () => { if (!this.cancelled) reply({ pid: 7, sessionId: 3, identityKey: 1 }); };
        this.admitted.resolve(undefined);
      } else if (operation["type"] === "signal-named") {
        expect(operation["signal"]).toBe("SIGKILL"); expect(operation["scope"]).toBe("process-group"); this.alive--;
        this.ports.at(-1)?.postMessage({ version: PROTOCOL_VERSION, sessionId: 3, sequence: 1, type: "exit", termination: { kind: "signal", signal: 9 } });
        reply(undefined);
      } else reply(undefined);
    };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id, version: PROTOCOL_VERSION, ok: true, value: undefined } })));
  }
  terminate(): void { for (const port of this.ports) port.close(); }
}

afterEach(() => { CreationWorker.instance?.terminate(); CreationWorker.instance = undefined; vi.unstubAllGlobals(); });

it("retires an admitted JS process before creation cancellation settles", async () => {
  vi.stubGlobal("Worker", CreationWorker);
  const backend = await UserspaceProcessBackend.create({ wasmUrl: "https://example.test/core.wasm", memoryMiB: 64 });
  const worker = CreationWorker.instance;
  if (worker === undefined) throw new Error("Missing worker");
  const cancellation = new AbortController();
  const creating = backend.spawnJS({ id: "fixture", version: "1", fileCount: 0, totalBytes: 0, runtimes: { supportingFiles: [] }, metadata: new Uint8Array(), rootTreeSha256: "a".repeat(64), cpuProfile: "x86-64-v2" }, "https://example.test/process.js", [], {}, "/workspace", undefined, cancellation.signal);
  const rejected = expect(creating).rejects.toMatchObject({ code: "ABORTED" });
  await worker.admitted.promise; cancellation.abort();
  await new Promise<void>(ready => setTimeout(ready, 10)); worker.publish();
  await rejected;
  expect(worker.alive).toBe(0);
  expect(worker.cancelled).toBe(false);
});
