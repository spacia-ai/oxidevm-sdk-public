import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewRuntimeClient, PreviewRuntimeServer, decodePreviewRuntimeRequest, encodePreviewRuntimeResponse } from "./preview-runtime-channel.js";

const channels: MessageChannel[] = [];
function fixture() {
  const channel = new MessageChannel();
  channels.push(channel);
  return { channel, client: new PreviewRuntimeClient(channel.port1) };
}
afterEach(() => { for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close(); } });

describe("shared preview runtime channel", () => {
  it("cancels a pending readiness operation in its owner and ignores a late completion", async () => {
    const { client, channel } = fixture();
    const started = Promise.withResolvers<AbortSignal>(), retired = Promise.withResolvers<undefined>();
    const late = Promise.withResolvers<{ readonly kind: "ready" }>();
    const server = new PreviewRuntimeServer(channel.port2, (_operation, signal) => {
      started.resolve(signal);
      signal.addEventListener("abort", () => { retired.resolve(undefined); }, { once: true });
      return late.promise;
    });
    channel.port2.onmessage = event => { server.receive(event.data); };
    channel.port1.onmessage = event => { client.receive(event.data); };
    const controller = new AbortController();
    const waiting = client.request({ kind: "wait", generation: 1n, process: 7, connection: 8, interest: "read" }, controller.signal);
    const signal = await started.promise;
    const rejected = expect(waiting).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await rejected; await retired.promise;
    expect(signal.aborted).toBe(true);
    late.resolve({ kind: "ready" });
    await Promise.resolve();
    client.close(); server.close();
  });

  it("bounds pending operations and retires them on channel disposal", async () => {
    const channel = new MessageChannel(); channels.push(channel);
    const signals: AbortSignal[] = [], responses: unknown[] = [];
    const server = new PreviewRuntimeServer({ postMessage: (value: unknown) => { responses.push(value); } }, (_operation, signal) => {
      signals.push(signal); return new Promise(() => undefined);
    });
    for (let sequence = 1; sequence <= 257; sequence++) {
      server.receive({ version: 2, kind: "preview-runtime", sequence, operation: { kind: "wait", generation: 1n, process: 7, connection: 8, interest: "read" } });
    }
    await Promise.resolve();
    expect(signals).toHaveLength(256);
    expect(responses).toContainEqual(encodePreviewRuntimeResponse(257, { kind: "error", code: "capacity" }));
    server.close();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(() => decodePreviewRuntimeRequest({ version: 1, kind: "preview-runtime", sequence: 1, operation: { kind: "open", process: null, port: 3000 } })).toThrow(/version/u);
  });
  it("rejects new requests after disposal without posting or retaining work", async () => {
    const { client, channel } = fixture();
    const post = vi.spyOn(channel.port1, "postMessage");
    client.close();
    await expect(client.request({ kind: "open", port: 3000, process: null })).rejects.toMatchObject({ code: "ABORTED" });
    expect(post).not.toHaveBeenCalled();
  });

  it("settles pending work and removes cancellation listeners on disposal", async () => {
    const { client } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = client.request({ kind: "open", port: 3000, process: null }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    client.close();
    client.close();
    await rejected;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("releases a request when port transfer fails", async () => {
    const { client, channel } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const failure = new DOMException("closed transport", "DataCloneError");
    vi.spyOn(channel.port1, "postMessage").mockImplementation(() => { throw failure; });
    await expect(client.request({ kind: "open", port: 3000, process: null }, controller.signal)).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    client.close();
  });

  it("retains existing request and response bytes during owner extraction", async () => {
    const { client, channel } = fixture();
    const posted = new Promise<unknown>(resolve => { channel.port2.onmessage = (event: MessageEvent<unknown>) => resolve(event.data); });
    const result = client.request({ kind: "open", port: 3000, process: null });
    const request = decodePreviewRuntimeRequest(await posted);
    expect(request).toEqual({ version: 2, kind: "preview-runtime", sequence: 1, operation: { kind: "open", port: 3000, process: null } });
    expect(client.receive(encodePreviewRuntimeResponse(1, { kind: "opened", generation: 1n, process: 7, connection: 8 }))).toBe(true);
    await expect(result).resolves.toEqual({ kind: "opened", generation: 1n, process: 7, connection: 8 });
    client.close();
  });
});

describe("preview open resolution", () => {
  it("requires the admitted connection generation on every operation after open", () => {
    const operation = { kind: "read", generation: 3n, process: 7, connection: 8, maxBytes: 64 };
    const request = { version: 2, kind: "preview-runtime", sequence: 1, operation };
    expect(decodePreviewRuntimeRequest(request)?.operation).toEqual(operation);
    for (const generation of [0n, -1n, 1n << 64n, 3, "3", undefined]) {
      expect(() => decodePreviewRuntimeRequest({ ...request, operation: { ...operation, generation } })).toThrow();
    }
  });
  it("carries the network-resolved listener process or null when the runtime must find it", () => {
    const decoded = decodePreviewRuntimeRequest({ version: 2, kind: "preview-runtime", sequence: 1, operation: { kind: "open", port: 3000, process: 7 } });
    expect(decoded?.operation).toEqual({ kind: "open", port: 3000, process: 7 });
    expect(decodePreviewRuntimeRequest({ version: 2, kind: "preview-runtime", sequence: 2, operation: { kind: "open", port: 3000 } })?.operation)
      .toEqual({ kind: "open", port: 3000, process: null });
    expect(decodePreviewRuntimeRequest({ version: 2, kind: "preview-runtime", sequence: 3, operation: { kind: "open", port: 3000, process: null } })?.operation)
      .toEqual({ kind: "open", port: 3000, process: null });
    for (const process of [0, -1, 1.5, "7", 0x1_0000_0000]) {
      expect(() => decodePreviewRuntimeRequest({ version: 2, kind: "preview-runtime", sequence: 4, operation: { kind: "open", port: 3000, process } })).toThrow();
    }
  });
});
