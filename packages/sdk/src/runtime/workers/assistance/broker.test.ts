const httpParser = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
import { afterEach, expect, it, vi } from "vitest";
import { brokerDataCredit } from "./traffic.ts";
import { ExecutionBroker } from "./broker.ts";
import { publishRequest, waitForReply } from "./mailbox.ts";
import { encodeAssistanceRequest } from "../../protocol/assistance.ts";
import { encodeAssistanceReply } from "../../protocol/assistance-reply.ts";
import type { AssistanceCredit } from "../../protocol/assistance-credit.ts";
import { encodeAssistanceEvent } from "../../protocol/assistance-event.ts";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
const identity = { ...binding, process: 1, sequence: 1 };
class ProcessWorker {
  static instances: ProcessWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly postMessage = vi.fn<(value: unknown, transfer?: readonly Transferable[]) => void>();
  readonly terminate = vi.fn();
  constructor() { ProcessWorker.instances.push(this); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); ProcessWorker.instances = []; });

function grants(process: number): AssistanceCredit[] {
  return ["data", "control"].map((pool, index) => ({ ...binding, process, kind: "grant", producer: "broker",
    pool: pool === "data" ? "data" : "control", sequence: process * 2 + index, reservation: process * 2 + index,
    bytes: pool === "data" ? 2 * 1024 * 1024 : 128 * 1024, entries: 128 }));
}

it("returns issued broker grants after reserved workers and transport buffers retire", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const nextCompiler = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), nextCompiler, httpParser);
  try {
    broker.receive({ kind: "reserve", identity, credits: grants(1) });
    broker.receive({ kind: "start", identity: { ...identity, sequence: 2 }, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const worker = ProcessWorker.instances[0];
    expect(worker?.postMessage).toHaveBeenCalledWith(expect.objectContaining({ nextCompilerModule: nextCompiler, httpParserModule: httpParser }), expect.any(Array));
    worker?.onmessage?.(new MessageEvent("message", { data: { kind: "ready", identity } }));
    worker?.onmessage?.(new MessageEvent("message", { data: { kind: "output", identity: { ...identity, sequence: 2 },
      stream: "stdout", bytes: new Uint8Array(64 * 1024) } }));
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 3 } });
    expect(worker?.terminate).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith({ kind: "retired", identity: { ...identity, sequence: 3 }, credits: grants(1).map(credit => ({ ...credit, kind: "return" })) });
    expect(() => broker.receive({ kind: "stop", identity: { ...identity, sequence: 4 } })).toThrow();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("reserves identities before asynchronous startup and retires cancelled reservations", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel();
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  const reserve = (process: number) => broker.receive({ kind: "reserve", identity: { ...identity, process }, credits: grants(process) });
  const start = (process: number) => broker.receive({ kind: "start", identity: { ...identity, process, sequence: 2 },
    entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
  try {
    for (const process of [1, 2, 3, 4]) reserve(process);
    expect(ProcessWorker.instances).toHaveLength(0);
    expect(() => reserve(5)).toThrow("capacity");
    start(2); start(1);
    expect(ProcessWorker.instances).toHaveLength(2);
    expect(() => start(1)).toThrow();
    broker.receive({ kind: "stop", identity: { ...identity, process: 3, sequence: 2 } });
    expect(() => reserve(3)).toThrow();
    reserve(5); start(5);
    expect(ProcessWorker.instances).toHaveLength(3);
    expect(() => start(3)).toThrow();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("reports terminal failure independently of an exhausted process sequence", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  // Observe the real owner's insertion; no production counter override is exposed.
  const insert = vi.spyOn(Map.prototype, "set");
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const worker = ProcessWorker.instances[0];
    const process: unknown = insert.mock.calls.find(call => {
      const value: unknown = call[1];
      return typeof value === "object" && value !== null && Reflect.get(value, "worker") === worker;
    })?.[1];
    insert.mockRestore();
    if (typeof process !== "object" || process === null) throw new Error("missing owned process");
    Reflect.set(process, "sequence", 0xffff_ffff);
    worker?.onmessageerror?.();
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]?.[0]).toMatchObject({ kind: "broker-failed", binding,
      error: { code: "PROTOCOL_ERROR", message: "Assisted worker message failed" } });
    expect(worker?.terminate).toHaveBeenCalledOnce();
  } finally { insert.mockRestore(); broker.dispose(); channel.port2.close(); }
});

it("fences queued guest traffic after worker failure without replacing its terminal error", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const worker = ProcessWorker.instances[0];
    worker?.onerror?.(Object.assign(new Event("error"), { error: undefined, message: "original failure", filename: "worker.js", lineno: 1, colno: 1 }));
    const event = { kind: "event", identity: { ...identity, sequence: 2 },
      bytes: encodeAssistanceEvent({ ...identity, event: { kind: "output", child: 1, stream: "stdout", bytes: Uint8Array.of(65) } }) };
    expect(() => broker.receive(event)).not.toThrow();
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]?.[0]).toMatchObject({ kind: "failed", error: { message: "Assisted worker was lost: original failure" } });
    expect(worker?.postMessage).toHaveBeenCalledOnce();
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 3 } });
    expect(worker?.terminate).toHaveBeenCalledOnce();
    broker.receive({ kind: "start", identity: { ...identity, process: 2 }, entry: "/workspace/b.cjs", cwd: "/workspace", args: [], env: {} });
    expect(ProcessWorker.instances).toHaveLength(2);
  } finally { broker.dispose(); channel.port2.close(); }
});

it("retains the worker initialization error and source location", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    ProcessWorker.instances[0]?.onerror?.(Object.assign(new Event("error"), { error: undefined, message: "runtime initialization failed", filename: "https://execution.test/assisted-process.worker.js", lineno: 12, colno: 3 }));
    expect(sent.mock.calls[0]?.[0]).toMatchObject({ kind: "failed", error: {
      message: "Assisted worker was lost: runtime initialization failed",
      detail: { filename: "https://execution.test/assisted-process.worker.js", line: 12, column: 3 },
    } });
  } finally { broker.dispose(); channel.port2.close(); }
});

it("terminates busy workers when the control lifeline disappears", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel();
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/busy.cjs", cwd: "/workspace", args: [], env: {} });
    vi.advanceTimersByTime(75_000);
    expect(ProcessWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("reports a broker-wide failure even when no process has started", async () => {
  const channel = new MessageChannel();
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  const outcome = Promise.withResolvers<unknown>();
  channel.port2.onmessage = (event: MessageEvent<unknown>) => outcome.resolve(event.data);
  try {
    channel.port2.postMessage({ kind: "forged" });
    await expect(outcome.promise).resolves.toMatchObject({ kind: "broker-failed", binding, error: { code: "PROTOCOL_ERROR" } });
  } finally { broker.dispose(); channel.port2.close(); }
});

it("answers connection liveness independently of application workers", () => {
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "ping", binding, sequence: 1 });
    expect(sent).toHaveBeenCalledWith({ kind: "pong", binding, sequence: 1 });
    expect(() => broker.receive({ kind: "ping", binding, sequence: 1 })).toThrow();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("forwards bound guest child events using independent command sequences", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel();
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const command = { kind: "event", identity: { ...identity, sequence: 2 },
      bytes: encodeAssistanceEvent({ ...identity, sequence: 7, event: { kind: "output", child: 1, stream: "stdout", bytes: Uint8Array.of(65) } }) };
    broker.receive(command);
    expect(ProcessWorker.instances[0]?.postMessage).toHaveBeenLastCalledWith(command, [command.bytes.buffer]);
    expect(() => broker.receive(command)).toThrow();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("closes a blocked mailbox and terminates its worker without application cooperation", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel();
  const compiler = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, compiler, Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/main.cjs", cwd: "/workspace", args: [], env: {} });
    const worker = ProcessWorker.instances[0];
    expect(worker).toBeDefined();
    const input: unknown = worker?.postMessage.mock.calls[0]?.[0];
    if (typeof input !== "object" || input === null || !("buffer" in input) || !(input.buffer instanceof SharedArrayBuffer)) throw new Error("missing mailbox");
    const buffer = input.buffer;
    publishRequest(buffer, 1, encodeAssistanceRequest({ ...identity, operation: { kind: "stat", path: "/workspace" } }));
    worker?.onmessage?.(new MessageEvent("message", { data: { kind: "pending", identity } }));
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 2 } });
    expect(worker?.terminate).toHaveBeenCalledOnce();
    expect(() => waitForReply(buffer, 1, 0)).toThrow("closed");
    broker.dispose();
    expect(worker?.terminate).toHaveBeenCalledOnce();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("does not admit a stale binding or reuse a process identity", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel();
  const compiler = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, compiler, Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  const start = { kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} };
  try {
    expect(() => broker.receive({ ...start, identity: { ...identity, generation: 2 } })).toThrow();
    expect(ProcessWorker.instances).toHaveLength(0);
    broker.receive(start);
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 2 } });
    expect(() => broker.receive(start)).toThrow();
    expect(ProcessWorker.instances).toHaveLength(1);
  } finally { broker.dispose(); channel.port2.close(); }
});

it("copies a mailbox request and matches the reply before waking it", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel();
  const sent = vi.spyOn(channel.port1, "postMessage");
  const compiler = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, compiler, Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const worker = ProcessWorker.instances[0];
    const input: unknown = worker?.postMessage.mock.calls[0]?.[0];
    if (typeof input !== "object" || input === null || !("buffer" in input) || !(input.buffer instanceof SharedArrayBuffer)) throw new Error("missing mailbox");
    const operation = { kind: "stat" as const, path: "/workspace" };
    const buffer = input.buffer;
    publishRequest(buffer, 1, encodeAssistanceRequest({ ...identity, operation }));
    worker?.onmessage?.(new MessageEvent("message", { data: { kind: "pending", identity } }));
    expect(sent).toHaveBeenCalledWith({ kind: "request", identity, operation });
    // The already-decoded request is independent of subsequent malicious writes.
    new Uint8Array(input.buffer, 16).fill(0);
    const bytes = encodeAssistanceReply({ ...identity, result: { kind: "error", errno: 2, code: "ENOENT", syscall: "stat", path: "/workspace", destination: null } });
    broker.receive({ kind: "reply", identity, bytes });
    expect(waitForReply(buffer, 1, 0)).toEqual(bytes);
  } finally { broker.dispose(); channel.port2.close(); }
});

it("acknowledges VM shutdown only after terminating workers and closing its producer", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const closed = vi.spyOn(channel.port1, "close");
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    broker.receive({ kind: "shutdown", binding, sequence: 1 });
    expect(ProcessWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith({ kind: "stopped", binding, sequence: 1 });
    expect(closed).toHaveBeenCalledOnce();
    expect(() => broker.receive({ kind: "ping", binding, sequence: 2 })).toThrow("disposed");
  } finally { broker.dispose(); channel.port2.close(); }
});

it("rejects insufficient runtime transfer credit before creating a worker and releases startup buffers", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const compiler = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, compiler, new Uint8Array(2 * 1024 * 1024), compiler, httpParser);
  try {
    broker.receive({ kind: "reserve", identity, credits: grants(1) });
    expect(() => broker.receive({ kind: "start", identity: { ...identity, sequence: 2 }, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} })).toThrow("capacity");
    expect(ProcessWorker.instances).toHaveLength(0);
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 3 } });
    expect(sent).toHaveBeenCalledWith({ kind: "retired", identity: { ...identity, sequence: 3 }, credits: grants(1).map(credit => ({ ...credit, kind: "return" })) });
  } finally { broker.dispose(); channel.port2.close(); }
});

it("returns startup grants if the browser cannot create the worker", () => {
  vi.stubGlobal("Worker", vi.fn(function unavailableWorker() { throw new Error("worker quota"); }));
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const compiler = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, compiler, Uint8Array.of(1), compiler, httpParser);
  try {
    broker.receive({ kind: "reserve", identity, credits: grants(1) });
    expect(() => broker.receive({ kind: "start", identity: { ...identity, sequence: 2 }, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} })).toThrow("worker quota");
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 3 } });
    expect(sent).toHaveBeenCalledWith({ kind: "retired", identity: { ...identity, sequence: 3 }, credits: grants(1).map(credit => ({ ...credit, kind: "return" })) });
  } finally { broker.dispose(); channel.port2.close(); }
});

it.each([1_199_467, 4 * 1024 * 1024])("starts a verified %i-byte runtime within the calculated task grant", size => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const compiler = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, compiler, new Uint8Array(size), compiler, httpParser);
  const credits = grants(1).map(grant => grant.pool === "data" ? { ...grant, bytes: brokerDataCredit(size) } : grant);
  try {
    broker.receive({ kind: "reserve", identity, credits });
    broker.receive({ kind: "start", identity: { ...identity, sequence: 2 }, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    expect(ProcessWorker.instances).toHaveLength(1);
    const worker = ProcessWorker.instances[0];
    worker?.onmessage?.(new MessageEvent("message", { data: { kind: "ready", identity } }));
    expect(sent).toHaveBeenCalledWith({ kind: "ready", identity });
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 3 } });
    expect(worker?.terminate).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith({ kind: "retired", identity: { ...identity, sequence: 3 }, credits: credits.map(credit => ({ ...credit, kind: "return" })) });
  } finally { broker.dispose(); channel.port2.close(); }
});


it("retires an explicit process exit with pending output without poisoning the broker", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const module = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, module, Uint8Array.of(1), module, httpParser);
  try {
    broker.receive({ kind: "reserve", identity, credits: grants(1) });
    broker.receive({ kind: "start", identity: { ...identity, sequence: 2 }, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const worker = ProcessWorker.instances[0];
    worker?.onmessage?.(new MessageEvent("message", { data: { kind: "ready", identity } }));
    worker?.onmessage?.(new MessageEvent("message", { data: { kind: "output", identity: { ...identity, sequence: 2 }, stream: "stdout", bytes: Uint8Array.of(65) } }));
    const exit = { kind: "exit-request", identity: { ...identity, sequence: 3 }, code: 7 };
    worker?.onmessage?.(new MessageEvent("message", { data: exit }));
    expect(sent).toHaveBeenLastCalledWith(exit);
    expect(worker?.terminate).toHaveBeenCalledOnce();
    expect(() => broker.receive({ kind: "reply", identity: { ...identity, sequence: 2 }, bytes: encodeAssistanceReply({ ...identity, sequence: 2, result: { kind: "unit" } }) })).not.toThrow();
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 3 } });
    expect(sent).toHaveBeenLastCalledWith({ kind: "retired", identity: { ...identity, sequence: 3 }, credits: grants(1).map(credit => ({ ...credit, kind: "return" })) });
  } finally { broker.dispose(); channel.port2.close(); }
});

function mailboxOf(worker: ProcessWorker | undefined): SharedArrayBuffer {
  const input: unknown = worker?.postMessage.mock.calls[0]?.[0];
  if (typeof input !== "object" || input === null || !("buffer" in input) || !(input.buffer instanceof SharedArrayBuffer)) throw new Error("missing mailbox");
  return input.buffer;
}

it("starts a fork child with a private channel handed to its parent after completing the parent's fork mailbox", async () => {
  const { encodeForkReply, encodeForkRequest } = await import("../../protocol/assistance-fork.ts");
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const module = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, module, Uint8Array.of(1), module, httpParser);
  const request = { entry: "/workspace/child.cjs", args: ["x"], execArgv: [], cwd: "/workspace", env: { A: "1" }, silent: true };
  try {
    broker.receive({ kind: "reserve", identity, credits: grants(1) });
    broker.receive({ kind: "start", identity: { ...identity, sequence: 2 }, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const parent = ProcessWorker.instances[0];
    parent?.onmessage?.(new MessageEvent("message", { data: { kind: "ready", identity } }));
    // The parent's synchronous fork request is copied out of its mailbox and
    // forwarded to control, which alone allocates the child's identity.
    const buffer = mailboxOf(parent);
    publishRequest(buffer, 2, encodeForkRequest(request));
    parent?.onmessage?.(new MessageEvent("message", { data: { kind: "pending-fork", identity: { ...identity, sequence: 2 } } }));
    expect(sent).toHaveBeenLastCalledWith({ kind: "fork", identity: { ...identity, sequence: 2 }, request });
    const reply = { kind: "spawned", process: 2, pid: 40 } as const;
    broker.receive({ kind: "fork-reply", identity: { ...identity, sequence: 2 }, reply });
    expect(waitForReply(buffer, 2, 0)).toEqual(encodeForkReply(reply));
    // Control then starts the child; the broker alone creates the IPC channel.
    broker.receive({ kind: "reserve", identity: { ...identity, process: 2 }, credits: grants(2) });
    broker.receive({ kind: "start", identity: { ...identity, process: 2, sequence: 2 }, ...request, parent: 1 });
    const child = ProcessWorker.instances[1];
    const bootstrap: unknown = child?.postMessage.mock.calls[0]?.[0];
    const transfer: unknown = child?.postMessage.mock.calls[0]?.[1];
    if (typeof bootstrap !== "object" || bootstrap === null) throw new Error("missing child bootstrap");
    expect(bootstrap).toMatchObject({ parent: 1, silent: true, entry: request.entry });
    const ipc: unknown = Reflect.get(bootstrap, "ipc");
    if (!(ipc instanceof MessagePort)) throw new Error("child bootstrap lacks its IPC port");
    expect(Array.isArray(transfer) && transfer.includes(ipc)).toBe(true);
    const handed: unknown = parent?.postMessage.mock.calls.at(-1)?.[0];
    const handedTransfer: unknown = parent?.postMessage.mock.calls.at(-1)?.[1];
    if (typeof handed !== "object" || handed === null) throw new Error("parent was not handed a channel");
    expect(handed).toMatchObject({ kind: "fork-channel", identity: { ...identity, sequence: 2 }, child: 2 });
    const port: unknown = Reflect.get(handed, "port");
    if (!(port instanceof MessagePort)) throw new Error("fork channel lacks a port");
    expect(Array.isArray(handedTransfer) && handedTransfer.includes(port)).toBe(true);
    // The two ends are one private channel; bytes never touch the broker.
    const received = new Promise<unknown>(resolve => { ipc.onmessage = (event: MessageEvent<unknown>) => resolve(event.data); });
    port.postMessage({ message: "\"hello\"" });
    await expect(received).resolves.toEqual({ message: "\"hello\"" });
    port.close(); ipc.close();
    // Control's fork commands reach the right worker in command order; a
    // channel can never be injected by control.
    const output = { kind: "fork-output", identity: { ...identity, sequence: 3 }, child: 2, stream: "stdout", bytes: Uint8Array.of(65), chunk: 1 };
    broker.receive(output);
    expect(parent?.postMessage).toHaveBeenLastCalledWith(output, [output.bytes.buffer]);
    const signal = { kind: "signal", identity: { ...identity, process: 2, sequence: 3 }, signal: "TERM" };
    broker.receive(signal);
    expect(child?.postMessage).toHaveBeenLastCalledWith(signal, []);
    expect(() => broker.receive({ kind: "fork-exit", identity: { ...identity, sequence: 3 }, child: 2, termination: { kind: "exit", code: 0 } })).toThrow("Out-of-order");
    const { port1 } = new MessageChannel();
    try { expect(() => broker.receive({ kind: "fork-channel", identity: { ...identity, sequence: 4 }, child: 2, port: port1 })).toThrow(); }
    finally { port1.close(); }
    // Stopping the parent leaves its child to control.
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 4 } });
    expect(parent?.terminate).toHaveBeenCalledOnce();
    expect(child?.terminate).not.toHaveBeenCalled();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("answers parent fork traffic with unit replies and ends a child on its exit signal", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(); const sent = vi.spyOn(channel.port1, "postMessage");
  const module = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
  const broker = new ExecutionBroker(channel.port1, binding, module, Uint8Array.of(1), module, httpParser);
  try {
    broker.receive({ kind: "start", identity, entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {} });
    const parent = ProcessWorker.instances[0];
    parent?.onmessage?.(new MessageEvent("message", { data: { kind: "ready", identity } }));
    broker.receive({ kind: "start", identity: { ...identity, process: 2 }, entry: "/workspace/c.cjs", cwd: "/workspace", args: [], env: {}, parent: 1, silent: true });
    const child = ProcessWorker.instances[1];
    child?.onmessage?.(new MessageEvent("message", { data: { kind: "ready", identity: { ...identity, process: 2 } } }));
    const input = { kind: "fork-input", identity: { ...identity, sequence: 2 }, child: 2, bytes: Uint8Array.of(1) };
    parent?.onmessage?.(new MessageEvent("message", { data: input }));
    expect(sent).toHaveBeenLastCalledWith(input);
    const acknowledgement = { kind: "fork-output-ack", identity: { ...identity, sequence: 3 }, child: 2, chunk: 1 };
    parent?.onmessage?.(new MessageEvent("message", { data: acknowledgement }));
    expect(sent).toHaveBeenLastCalledWith(acknowledgement);
    const kill = { kind: "fork-signal", identity: { ...identity, sequence: 4 }, child: 2, signal: "KILL" };
    parent?.onmessage?.(new MessageEvent("message", { data: kill }));
    expect(sent).toHaveBeenLastCalledWith(kill);
    const unit = (sequence: number) => ({ kind: "reply", identity: { ...identity, sequence }, bytes: encodeAssistanceReply({ ...identity, sequence, result: { kind: "unit" } }) });
    broker.receive(unit(2));
    expect(parent?.postMessage).toHaveBeenLastCalledWith(unit(2), [unit(2).bytes.buffer]);
    expect(() => broker.receive(unit(3))).toThrow("Unknown assisted completion");
    broker.receive(unit(4));
    const ended = { kind: "exit-signal", identity: { ...identity, process: 2, sequence: 2 }, signal: 15 };
    child?.onmessage?.(new MessageEvent("message", { data: ended }));
    expect(sent).toHaveBeenLastCalledWith(ended);
    expect(child?.terminate).toHaveBeenCalledOnce();
  } finally { broker.dispose(); channel.port2.close(); }
});

it("sends one attention notice before every message it posts to control once control attached a notice port", () => {
  vi.stubGlobal("Worker", ProcessWorker);
  const channel = new MessageChannel(), notices = new MessageChannel(), order: string[] = [];
  vi.spyOn(channel.port1, "postMessage").mockImplementation(() => { order.push("message"); });
  vi.spyOn(notices.port1, "postMessage").mockImplementation(() => { order.push("notice"); });
  const broker = new ExecutionBroker(channel.port1, binding,
    new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), Uint8Array.of(1), new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), httpParser);
  try {
    expect(() => broker.receive({ kind: "attention", binding: { ...binding, generation: 2 }, port: notices.port1 })).toThrow();
    broker.receive({ kind: "attention", binding, port: notices.port1 });
    broker.receive({ kind: "ping", binding, sequence: 1 });
    broker.receive({ kind: "reserve", identity, credits: grants(1) });
    broker.receive({ kind: "stop", identity: { ...identity, sequence: 2 } });
    expect(order).toEqual(["notice", "message", "notice", "message"]);
    expect(() => broker.receive({ kind: "attention", binding, port: notices.port2 })).toThrow(/already attached/u);
  } finally { broker.dispose(); channel.port2.close(); notices.port2.close(); }
});
