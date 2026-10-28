import { expect, it } from "vitest";
import { GrantedTraffic } from "./assistance/traffic.js";
import { SystemListeners } from "./system-listeners.js";
import { PreviewRuntimeClient, decodePreviewRuntimeRequest, encodePreviewRuntimeResponse } from "./preview-runtime-channel.js";
import { SystemPreviewRuntime } from "./system-preview-runtime.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, producer: "network", process: null } as const;
function fixture() {
  const grant = { ...binding, kind: "grant", pool: "data", bytes: 1024 * 1024, entries: 8, sequence: 1, reservation: 1 } as const;
  const listeners = new SystemListeners(new GrantedTraffic(binding, [grant, { ...grant, pool: "control", bytes: 64 * 1024, sequence: 2, reservation: 2 }], 6));
  const channel = new MessageChannel();
  const client = new PreviewRuntimeClient(channel.port1);
  channel.port1.onmessage = event => { client.receive(event.data); };
  const served: unknown[] = [];
  channel.port2.onmessage = event => {
    const request = decodePreviewRuntimeRequest(event.data);
    if (request === undefined) return;
    served.push(request.operation);
    const operation = request.operation;
    channel.port2.postMessage(encodePreviewRuntimeResponse(request.sequence,
      operation.kind === "open" ? { kind: "opened", generation: 1n, process: operation.process ?? 0, connection: 9 } : { kind: "closed" }));
  };
  const lifetime = new AbortController();
  return { listeners, client, served, lifetime, runtime: new SystemPreviewRuntime(listeners, client, lifetime.signal),
    close: () => { client.close(); channel.port1.close(); channel.port2.close(); } };
}

it("resolves the listener task before asking control to connect, and forwards resolved requests as they are", async () => {
  const { listeners, served, runtime, close } = fixture();
  try {
    listeners.openTask(3);
    const opening = runtime.request({ kind: "open", port: 3000, process: null });
    listeners.open(3, 5, { address: "0.0.0.0", port: 3000 });
    await expect(opening).resolves.toEqual({ kind: "opened", generation: 1n, process: 3, connection: 9 });
    expect(served).toEqual([{ kind: "open", port: 3000, process: 3 }]);
    await expect(runtime.request({ kind: "close", generation: 1n, process: 3, connection: 9 })).resolves.toEqual({ kind: "closed" });
  } finally { close(); }
});

it("answers a listener error when the caller cancels or the generation retires before a listener appears", async () => {
  const { listeners, runtime, lifetime, close } = fixture();
  try {
    listeners.openTask(3);
    const controller = new AbortController();
    const cancelled = runtime.request({ kind: "open", port: 3000, process: null }, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toEqual({ kind: "error", code: "listener" });
    const retiring = runtime.request({ kind: "open", port: 3000, process: null });
    listeners.retire(); lifetime.abort();
    await expect(retiring).resolves.toEqual({ kind: "error", code: "listener" });
    await expect(runtime.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "channel" });
  } finally { close(); }
});

it("names the assisted task that holds a port, for routing", () => {
  const { listeners, runtime, close } = fixture();
  try {
    listeners.openTask(3);
    expect(runtime.holder(3000)).toBeUndefined();
    listeners.open(3, 5, { address: "0.0.0.0", port: 3000 });
    expect(runtime.holder(3000)).toBe(3);
    expect(runtime.holder(3001)).toBeUndefined();
  } finally { close(); }
});
