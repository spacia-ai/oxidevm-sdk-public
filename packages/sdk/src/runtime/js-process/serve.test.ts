import { afterEach, expect, it, vi } from "vitest";
import { SIGNAL_BUFFER_BYTES } from "./signals.js";
import { record } from "../decode.js";
import { JS_MAILBOX_BYTES, JS_PROCESS_PROTOCOL_VERSION } from "./codec.js";
import { RUNNER_LAUNCH_DESCRIPTOR_BYTES } from "./launch.js";
import { serveRunnerProcess } from "./serve.js";

afterEach(() => vi.unstubAllGlobals());

/** Installs the runner's bootstrap in a fake worker scope and returns its receiver and what it posted. */
function runner(handler: (launch: unknown) => unknown) {
  const postMessage = vi.fn<(message: unknown) => void>();
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown) => void } = { onmessage: null, postMessage };
  vi.stubGlobal("self", scope);
  serveRunnerProcess((_client, _context, launch) => handler(launch));
  const receive = scope.onmessage;
  if (receive === null) throw new Error("The runner bootstrap installed no receiver");
  return { receive, postMessage };
}

function start(extra: Readonly<Record<string, unknown>>) {
  const channel = new MessageChannel();
  return { channel, data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", port: channel.port1, mailbox: new SharedArrayBuffer(JS_MAILBOX_BYTES), signals: new SharedArrayBuffer(SIGNAL_BUFFER_BYTES), ...extra } };
}

it("hands the module runner the launch its start message carries, and none when it carries none", async () => {
  // JS process protocol 5 (ADR 0028): spawnModule's launch carries the VM's verified copies like a command's.
  const host = { kind: "host", descriptor: "{\"v\":1}", adapter: new Blob(["export default () => ({ main: () => 0 });"]), artifacts: { "data.bin": { blob: new Blob([]), module: null } }, tls: null } as const;
  for (const [extra, expected] of [[{ launch: host }, host], [{}, undefined]] as const) {
    const launches: unknown[] = [], { receive, postMessage } = runner(launch => { launches.push(launch); return 7; });
    const { channel, data } = start(extra);
    try {
      receive(new MessageEvent("message", { data }));
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 7 }));
      expect(launches).toEqual([expected]);
    } finally { channel.port1.close(); channel.port2.close(); }
  }
});

// Engine ADR 0027: a program in the VM ran an enabled command, and the runner starts with the registration's verified copies.
it("hands the module runner a module command's launch with its verified copies", async () => {
  const module = new WebAssembly.Module(Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0)), adapter = new Blob(["export default () => ({ main: () => 0 });"], { type: "text/javascript" });
  const launch = { kind: "module-command", invocation: { name: "python", path: "/usr/local/bin/python" }, terminals: { stdin: true, stdout: false, stderr: true }, descriptor: "{\"v\":1}", adapter, artifacts: { "tool.wasm": { blob: new Blob([]), module }, "data.bin": { blob: new Blob([]), module: null } }, tls: { blob: new Blob([]), module } };
  const launches: unknown[] = [], { receive, postMessage } = runner(received => { launches.push(received); return 0; });
  const { channel, data } = start({ launch });
  try {
    receive(new MessageEvent("message", { data }));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: 0 }));
    expect(launches).toEqual([launch]);
    const [received] = launches;
    expect(Reflect.get(Reflect.get(Reflect.get(Object(received), "artifacts"), "tool.wasm"), "module")).toBe(module);
  } finally { channel.port1.close(); channel.port2.close(); }
});

it("refuses a malformed launch before the runner starts", async () => {
  const command = { kind: "module-command", invocation: { name: "python", path: "/usr/local/bin/python" }, terminals: { stdin: false, stdout: false, stderr: false }, descriptor: "{}", adapter: new Blob([]), artifacts: {}, tls: null };
  for (const launch of [{ kind: "module-command", descriptor: "{}" }, { ...command, extra: 1 }, { ...command, invocation: { name: "python", path: "/usr/bin/python" } }, { ...command, invocation: { name: "Python", path: "/usr/local/bin/Python" } },
    { ...command, terminals: { stdin: 1, stdout: false, stderr: false } }, { ...command, adapter: "export {};" }, { ...command, artifacts: { "a.wasm": { blob: new Blob([]), module: {} } } },
    { ...command, artifacts: { "a.bin": { blob: new Uint8Array(), module: null } } }, { ...command, artifacts: { "a.bin": { blob: new Blob([]), module: null, url: "x" } } },
    { ...command, artifacts: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`f${String(index)}`, { blob: new Blob([]), module: null }])) }, { ...command, descriptor: "x".repeat(RUNNER_LAUNCH_DESCRIPTOR_BYTES + 1) }, { kind: "host" }, { kind: "host", descriptor: 1 }, { kind: "host", descriptor: "{}", extra: true },
    { kind: "host", descriptor: "x".repeat(RUNNER_LAUNCH_DESCRIPTOR_BYTES + 1) }, { kind: "host", descriptor: "é".repeat(RUNNER_LAUNCH_DESCRIPTOR_BYTES / 2 + 1) }, "host", null]) {
    const handler = vi.fn(() => 0), { receive, postMessage } = runner(handler);
    const { channel, data } = start({ launch });
    try {
      receive(new MessageEvent("message", { data }));
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
      const failure = record(postMessage.mock.calls[0]?.[0], "runner failure");
      expect(failure["type"]).toBe("failure"); expect(record(failure["error"], "runner error")["code"]).toBe("PROTOCOL_ERROR");
      expect(handler).not.toHaveBeenCalled();
    } finally { channel.port1.close(); channel.port2.close(); }
  }
});

it("refuses protocol 4 starts and a host launch without its copies (JS process protocol 5)", async () => {
  for (const extra of [{ version: 4 }, { launch: { kind: "host", descriptor: "{\"v\":1}" } }, { launch: { kind: "host", descriptor: "{\"v\":1}", adapter: new Blob([]), artifacts: {}, extra: 1 } }]) {
    const launches: unknown[] = [], { receive, postMessage } = runner(launch => { launches.push(launch); return 0; });
    const { channel, data } = start(extra);
    try {
      receive(new MessageEvent("message", { data }));
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ version: JS_PROCESS_PROTOCOL_VERSION, type: "failure" })));
      expect(launches).toEqual([]);
    } finally { channel.port1.close(); channel.port2.close(); }
  }
  expect(JS_PROCESS_PROTOCOL_VERSION).toBe(5);
});
