import { afterEach, expect, it, vi } from "vitest";
import { record } from "./runtime/decode.js";
import { serveProcess } from "./js-process.js";
import { JS_MAILBOX_BYTES, JS_PROCESS_PROTOCOL_VERSION } from "./runtime/js-process/codec.js";

afterEach(() => vi.unstubAllGlobals());

it("rejects an incompatible worker bootstrap before invoking application code", async () => {
  const postMessage = vi.fn<(message: unknown) => void>();
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown) => void } = { onmessage: null, postMessage };
  vi.stubGlobal("self", scope);
  const application = vi.fn(() => 0);
  serveProcess(application);
  const receive = scope.onmessage;
  if (receive === null) throw new Error("serveProcess did not install its worker boundary");
  receive(new MessageEvent("message", { data: { version: 999, type: "start" } }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
  const result = record(postMessage.mock.calls[0]?.[0], "worker failure");
  expect(result["version"]).toBe(JS_PROCESS_PROTOCOL_VERSION); expect(result["type"]).toBe("failure");
  expect(record(result["error"], "error")["code"]).toBe("PROTOCOL_ERROR");
  expect(application).not.toHaveBeenCalled();
});

it.each(["sync", "async"])("accepts a named %s handler that returns nothing", async kind => {
  const postMessage = vi.fn<(message: unknown) => void>();
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown) => void } = { onmessage: null, postMessage };
  vi.stubGlobal("self", scope);
  function program(): void {}
  async function asyncProgram(): Promise<void> { await Promise.resolve(); }
  serveProcess(kind === "sync" ? program : asyncProgram);
  const receive = scope.onmessage;
  if (receive === null) throw new Error("Missing worker receiver");
  const channel = new MessageChannel();
  try {
    receive(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", port: channel.port1, mailbox: new SharedArrayBuffer(JS_MAILBOX_BYTES) } }));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 0 }));
  } finally { channel.port1.close(); channel.port2.close(); }
});

it.each([null, {}, 256])("rejects an invalid handler result %j before publishing an exit", async result => {
  const postMessage = vi.fn<(message: unknown) => void>();
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown) => void } = { onmessage: null, postMessage };
  vi.stubGlobal("self", scope);
  serveProcess(() => result);
  const receive = scope.onmessage;
  if (receive === null) throw new Error("Missing worker receiver");
  const channel = new MessageChannel();
  try {
    receive(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", port: channel.port1, mailbox: new SharedArrayBuffer(JS_MAILBOX_BYTES) } }));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const failure = record(postMessage.mock.calls[0]?.[0], "worker result");
    expect(failure["type"]).toBe("failure"); expect(record(failure["error"], "worker error")["code"]).toBe("PROTOCOL_ERROR");
  } finally { channel.port1.close(); channel.port2.close(); }
});

it("rejects a bootstrap from a runtime on the previous JS process protocol", async () => {
  const postMessage = vi.fn<(message: unknown) => void>();
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown) => void } = { onmessage: null, postMessage };
  vi.stubGlobal("self", scope);
  const application = vi.fn(() => 0);
  serveProcess(application);
  const receive = scope.onmessage;
  if (receive === null) throw new Error("Missing worker receiver");
  const channel = new MessageChannel();
  try {
    receive(new MessageEvent("message", { data: { version: JS_PROCESS_PROTOCOL_VERSION - 1, type: "start", port: channel.port1, mailbox: new SharedArrayBuffer(JS_MAILBOX_BYTES) } }));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const failure = record(postMessage.mock.calls[0]?.[0], "worker failure");
    expect(failure["type"]).toBe("failure"); expect(record(failure["error"], "worker error")["code"]).toBe("PROTOCOL_ERROR");
    expect(application).not.toHaveBeenCalled();
  } finally { channel.port1.close(); channel.port2.close(); }
});
