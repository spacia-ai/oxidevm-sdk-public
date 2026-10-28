import { expect, it, vi } from "vitest";
import { VMError } from "../../errors.js";
import type { AssistanceSocketOperation } from "../../protocol/assistance.js";
import type { AssistanceReply } from "../../protocol/assistance-reply.js";
import { PreviewRuntimeClient } from "../preview-runtime-channel.js";
import { PreviewRuntimeServicer } from "./preview-runtime.js";

function fixture(previewSocket: (process: number, operation: AssistanceSocketOperation) => Promise<AssistanceReply["result"] | undefined>) {
  const channel = new MessageChannel();
  const servicer = new PreviewRuntimeServicer(channel.port1, { previewSocket }, 1n);
  const client = new PreviewRuntimeClient(channel.port2);
  channel.port2.onmessage = event => { client.receive(event.data); };
  return { client, servicer, close: () => { servicer.close(); client.close(); channel.port2.close(); } };
}

it("connects inside the listener task, streams through its socket, and maps EOF and refusals to completions", async () => {
  const calls: AssistanceSocketOperation[] = [];
  const { client, close } = fixture((process, operation) => {
    calls.push(operation);
    if (process !== 4) return Promise.resolve(undefined);
    if (operation.kind === "socket-connect-local") {
      return Promise.resolve(operation.address.port === 3000
        ? { kind: "socket", fd: 12, local: { address: "127.0.0.1", port: 40000 }, peer: operation.address }
        : { kind: "error", errno: 111, code: "ECONNREFUSED", syscall: "connect", path: null, destination: null });
    }
    if (operation.kind === "socket-write") return Promise.resolve({ kind: "written", count: operation.bytes.length });
    if (operation.kind === "socket-read") return Promise.resolve({ kind: "data", bytes: operation.length === 5 ? new Uint8Array([1, 2, 3]) : new Uint8Array() });
    if (operation.kind === "socket-close") return Promise.resolve({ kind: "unit" });
    throw new Error(`unexpected ${operation.kind}`);
  });
  try {
    await expect(client.request({ kind: "open", port: 3000, process: 4 })).resolves.toEqual({ kind: "opened", generation: 1n, process: 4, connection: 12 });
    await expect(client.request({ kind: "open", port: 3001, process: 4 })).resolves.toEqual({ kind: "error", code: "listener" });
    await expect(client.request({ kind: "open", port: 3000, process: 9 })).resolves.toEqual({ kind: "error", code: "process" });
    await expect(client.request({ kind: "open", port: 3000, process: null })).resolves.toEqual({ kind: "error", code: "listener" });
    await expect(client.request({ kind: "write", generation: 1n, process: 4, connection: 12, bytes: new Uint8Array([7, 7]) })).resolves.toEqual({ kind: "written", bytes: 2 });
    await expect(client.request({ kind: "read", generation: 1n, process: 4, connection: 12, maxBytes: 5 })).resolves.toEqual({ kind: "read", bytes: new Uint8Array([1, 2, 3]) });
    await expect(client.request({ kind: "read", generation: 1n, process: 4, connection: 12, maxBytes: 65_536 })).resolves.toEqual({ kind: "eof" });
    await expect(client.request({ kind: "close", generation: 1n, process: 4, connection: 12 })).resolves.toEqual({ kind: "closed" });
    expect(calls.map(call => call.kind)).toEqual(["socket-connect-local", "socket-connect-local", "socket-connect-local", "socket-write", "socket-read", "socket-read", "socket-close"]);
  } finally { close(); }
});

it("reports a task or transport failure as a phase completion instead of failing the owner", async () => {
  const { client, close } = fixture(() => Promise.reject(new VMError("ABORTED", "task retired")));
  try {
    await expect(client.request({ kind: "read", generation: 1n, process: 4, connection: 12, maxBytes: 10 })).resolves.toEqual({ kind: "error", code: "read" });
    await expect(client.request({ kind: "open", port: 3000, process: 4 })).resolves.toEqual({ kind: "error", code: "listener" });
  } finally { close(); }
});

it("stops answering once closed", async () => {
  const previewSocket = vi.fn(() => Promise.resolve({ kind: "unit" } as const));
  const { client, servicer, close } = fixture(previewSocket);
  try {
    servicer.close();
    const controller = new AbortController();
    const pending = client.request({ kind: "close", generation: 1n, process: 4, connection: 1 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  } finally { close(); }
});

it("shuts down a blocked socket on cancellation and rejects stale generations", async () => {
  const reading = Promise.withResolvers<undefined>();
  const calls: AssistanceSocketOperation[] = [];
  const { client, close } = fixture(async (_process, operation) => {
    calls.push(operation);
    if (operation.kind === "socket-read") { reading.resolve(undefined); return new Promise(() => {}); }
    return { kind: "unit" };
  });
  try {
    await expect(client.request({ kind: "read", generation: 2n, process: 4, connection: 12, maxBytes: 1 })).resolves.toEqual({ kind: "error", code: "process" });
    expect(calls).toEqual([]);
    const stop = new AbortController();
    const pending = client.request({ kind: "read", generation: 1n, process: 4, connection: 12, maxBytes: 1 }, stop.signal);
    await reading.promise;
    const shut = vi.waitFor(() => { expect(calls.at(-1)).toEqual({ kind: "socket-shutdown", fd: 12, direction: "both" }); });
    stop.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await shut;
  } finally { close(); }
});

it("closes a connected socket if its cancelled open completes late", async () => {
  const connected = Promise.withResolvers<AssistanceReply["result"]>();
  const started = Promise.withResolvers<undefined>();
  const calls: AssistanceSocketOperation[] = [];
  const { client, close } = fixture((_process, operation) => {
    calls.push(operation);
    if (operation.kind === "socket-connect-local") { started.resolve(undefined); return connected.promise; }
    return Promise.resolve({ kind: "unit" });
  });
  try {
    const stop = new AbortController();
    const pending = client.request({ kind: "open", process: 4, port: 3000 }, stop.signal);
    await started.promise; stop.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    connected.resolve({ kind: "socket", fd: 12, local: { address: "127.0.0.1", port: 40000 }, peer: { address: "127.0.0.1", port: 3000 } });
    await vi.waitFor(() => { expect(calls.at(-1)).toEqual({ kind: "socket-close", fd: 12 }); });
  } finally { close(); }
});
