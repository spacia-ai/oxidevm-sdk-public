import { ProcessScheduler } from "./process-scheduler.ts";
import { expect, it, vi } from "vitest";
import { ProcessIO } from "./process-io.ts";
import { createMailbox } from "./mailbox.ts";
import { encodeAssistanceReply } from "../../protocol/assistance-reply.ts";
import type { BrokerEvent } from "../../protocol/assistance-broker.ts";
import { encodeAssistanceEvent } from "../../protocol/assistance-event.ts";
import { createAsyncFiles } from "./node-files-async.ts";
import { createAsyncContext } from "./async-context.ts";
import { decodeAssistanceRequest } from "../../protocol/assistance.ts";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1, sequence: 1 };

it("rejects unavailable system-agent cancellation before dispatch", () => {
  const send = vi.fn(), io = new ProcessIO(identity, createMailbox(), send);
  try {
    expect(() => io.call({ kind: "socket-connect-local", address: { address: "::1", port: 8080 } }, false, new AbortController().signal)).toThrow(/cancellation is unavailable/u);
    expect(send).not.toHaveBeenCalled(); expect(io.hasPending).toBe(false);
  } finally { io.close(new Error("test cleanup")); }
});

it("admits four maximum reads within the production worker reply partition", async () => {
  const io = new ProcessIO(identity, createMailbox(), () => {}, 512 * 1024);
  const pending: Promise<unknown>[] = [];
  try {
    expect(() => {
      for (let fd = 1; fd <= 4; fd++) pending.push(io.call({ kind: "read", fd, length: 65536, offset: null }));
    }).not.toThrow();
  } finally { const results = Promise.allSettled(pending); io.close(new Error("cleanup")); await results; }
});

it("reserves acknowledgement progress while data replies block and retires queued control work", async () => {
  const messages: Extract<BrokerEvent, { kind: "request" }>[] = [];
  const io = new ProcessIO(identity, createMailbox(), event => { if (event.kind === "request") messages.push(event); });
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < 11; index++) pending.push(io.call({ kind: "read", fd: index + 1, length: 65536, offset: null }));
  expect(() => io.call({ kind: "read", fd: 12, length: 65536, offset: null })).toThrow("traffic exhausted");
  const acknowledgement = io.call({ kind: "ack", child: 1, stream: "stdout", sequence: 1, bytes: 16384 });
  const message = messages.at(-1);
  if (message?.operation.kind !== "ack") throw new Error("acknowledgement blocked by data");
  io.receive({ kind: "reply", identity: message.identity, bytes: encodeAssistanceReply({ ...message.identity, result: { kind: "unit" } }) });
  await acknowledgement;
  for (let sequence = 2; sequence < 10; sequence++) pending.push(io.call({ kind: "ack", child: 1, stream: "stdout", sequence, bytes: 16384 }));
  const outcomes = Promise.allSettled(pending);
  io.close(new Error("retired"));
  expect((await outcomes).every(outcome => outcome.status === "rejected")).toBe(true);
  await expect(io.drain()).rejects.toThrow("retired");
});

it("backpressures a burst of child acknowledgements without exhausting reply reservations", async () => {
  const messages: Extract<BrokerEvent, { kind: "request" }>[] = [];
  const io = new ProcessIO(identity, createMailbox(), event => { if (event.kind === "request") messages.push(event); });
  const pending: Promise<unknown>[] = [];
  try {
    expect(() => {
      for (let sequence = 1; sequence <= 32; sequence++) pending.push(io.call({ kind: "ack", child: 1, stream: "stdout", sequence, bytes: 16384 }));
    }).not.toThrow();
    for (let index = 0; index < 32; index++) {
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(index));
      const message = messages[index];
      if (message === undefined) throw new Error("missing acknowledgement");
      expect(message.identity.sequence).toBe(index + 1);
      io.receive({ kind: "reply", identity: message.identity, bytes: encodeAssistanceReply({ ...message.identity, result: { kind: "unit" } }) });
      await pending[index];
    }
    await io.drain();
    expect(io.hasPending).toBe(false);
  } finally { io.close(new Error("test cleanup")); await Promise.allSettled(pending); }
});

it("flushes queued child acknowledgements before synchronous Linux work", async () => {
  const { takeRequest, completeReply } = await import("./mailbox.ts");
  const buffer = createMailbox();
  const seen: string[] = [];
  const io = new ProcessIO(identity, buffer, event => {
    if (event.kind === "request") seen.push(event.operation.kind);
    if (event.kind === "pending") {
      const request = decodeAssistanceRequest(takeRequest(buffer, event.identity.sequence));
      seen.push(request.operation.kind);
      completeReply(buffer, event.identity.sequence, encodeAssistanceReply({ ...event.identity, result: { kind: "unit" } }));
    }
  });
  const first = io.call({ kind: "ack", child: 1, stream: "stdout", sequence: 1, bytes: 1 });
  const second = io.call({ kind: "ack", child: 1, stream: "stdout", sequence: 2, bytes: 1 });
  const results = Promise.allSettled([first, second]);
  try {
    io.callSync({ kind: "close", fd: 1 });
    expect(seen).toEqual(["ack", "ack", "close"]);
  } finally { io.close(new Error("cleanup")); await results; }
});

it("retains an entire filesystem operation between its Linux replies", async () => {
  const messages: BrokerEvent[] = [];
  const io = new ProcessIO(identity, createMailbox(), event => { if (event.kind === "request") messages.push(event); });
  const files = createAsyncFiles(operation => io.call(operation), () => "/workspace", createAsyncContext(), () => io.retain());
  const reading = files.promises.readFile("file", "utf8");
  io.receive({ kind: "reply", identity, bytes: encodeAssistanceReply({ ...identity, result: { kind: "opened", fd: 1 } }) });
  expect(io.hasPending).toBe(true);
  expect(() => io.exit(0)).toThrow("pending I/O");
  await Promise.resolve();
  const read = messages.at(-1);
  if (read?.kind !== "request" || read.operation.kind !== "read") throw new Error("missing read");
  io.receive({ kind: "reply", identity: read.identity, bytes: encodeAssistanceReply({ ...read.identity, result: { kind: "data", bytes: new Uint8Array() } }) });
  expect(io.hasPending).toBe(true);
  await Promise.resolve();
  const close = messages.at(-1);
  if (close?.kind !== "request" || close.operation.kind !== "close") throw new Error("missing close");
  io.receive({ kind: "reply", identity: close.identity, bytes: encodeAssistanceReply({ ...close.identity, result: { kind: "unit" } }) });
  await expect(reading).resolves.toBe("");
  await io.drain();
  expect(io.hasPending).toBe(false);
});

it("acknowledges stdin only after its bounded consumer accepts it", async () => {
  const messages: unknown[] = [];
  const accepted = Promise.withResolvers<undefined>();
  const io = new ProcessIO(identity, createMailbox(), value => { messages.push(value); });
  io.setInput(async bytes => { expect(bytes).toEqual(Uint8Array.of(65)); await accepted.promise; });
  io.receive({ kind: "input", identity: { ...identity, sequence: 2 }, bytes: Uint8Array.of(65) });
  expect(messages).toEqual([]);
  expect(io.hasPending).toBe(true);
  accepted.resolve(undefined);
  await io.drain();
  expect(messages).toEqual([{ kind: "input-ack", identity, sequence: 2 }]);
});

it("delivers guest child events without consuming process request sequences", () => {
  const messages: unknown[] = [];
  const io = new ProcessIO(identity, createMailbox(), value => { messages.push(value); });
  const received: unknown[] = [];
  io.setChildEvents(event => { received.push(event); });
  const event = { ...identity, sequence: 7, event: { kind: "eof", child: 1, stream: "stdout" } };
  const command = { kind: "event", identity: { ...identity, sequence: 2 }, bytes: encodeAssistanceEvent(event) };
  io.receive(command);
  expect(received).toEqual([event]);
  expect(() => io.receive(command)).toThrow();
  io.ready();
  expect(messages).toEqual([{ kind: "ready", identity }]);
});

it("keeps asynchronous Linux calls pending and rejects duplicate and stale completions", async () => {
  const messages: unknown[] = [];
  const io = new ProcessIO(identity, createMailbox(), value => { messages.push(value); });
  const read = io.call({ kind: "read", fd: 1, length: 8, offset: null });
  expect(messages).toEqual([{ kind: "request", identity, operation: { kind: "read", fd: 1, length: 8, offset: null } }]);
  const bytes = encodeAssistanceReply({ ...identity, result: { kind: "data", bytes: Uint8Array.of(7) } });
  expect(() => io.receive({ kind: "reply", identity: { ...identity, generation: 2 }, bytes })).toThrow();
  io.receive({ kind: "reply", identity, bytes });
  await expect(read).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(7) });
  expect(() => io.receive({ kind: "reply", identity, bytes })).toThrow();
  await io.drain();
});

it("chunks output and waits for each acknowledgement before advancing", async () => {
  const messages: BrokerEvent[] = [];
  const io = new ProcessIO(identity, createMailbox(), value => {
    if (value.kind === "output") messages.push(value);
  });
  const write = io.output("stdout", new Uint8Array(65537));
  expect(messages).toHaveLength(1);
  const first = messages[0];
  if (first?.kind !== "output") throw new Error("missing output");
  expect(first.bytes).toHaveLength(65536);
  io.receive({ kind: "reply", identity, bytes: encodeAssistanceReply({ ...identity, result: { kind: "unit" } }) });
  await Promise.resolve();
  const second = messages[1];
  if (second?.kind !== "output") throw new Error("missing output");
  expect(second.bytes).toHaveLength(1);
  io.receive({ kind: "reply", identity: second.identity, bytes: encodeAssistanceReply({ ...second.identity, result: { kind: "unit" } }) });
  await write;
  await io.drain();
});

it("settles pending operations when its owner closes", async () => {
  const io = new ProcessIO(identity, createMailbox(), () => {});
  const read = io.call({ kind: "read", fd: 1, length: 8, offset: null });
  const failure = expect(read).rejects.toThrow("closed");
  io.close(new Error("closed"));
  io.close(new Error("duplicate"));
  await failure;
  expect(() => io.callSync({ kind: "stat", path: "/" })).toThrow("closed");
});

it("publishes a strict identity and validates synchronous replies without a finite I/O deadline", async () => {
  const { takeRequest, completeReply } = await import("./mailbox.ts");
  const buffer = createMailbox();
  const io = new ProcessIO(identity, buffer, event => {
    expect(event).toEqual({ kind: "pending", identity });
    takeRequest(buffer, 1);
    completeReply(buffer, 1, encodeAssistanceReply({ ...identity, result: { kind: "data", bytes: Uint8Array.of(4) } }));
  });
  expect(io.callSync({ kind: "read", fd: 1, length: 1, offset: null })).toEqual({ kind: "data", bytes: Uint8Array.of(4) });
});

it("does not consume a sequence for a rejected operation", () => {
  const messages: unknown[] = [];
  const io = new ProcessIO(identity, createMailbox(), value => { messages.push(value); });
  expect(() => io.callSync({ kind: "read", fd: 0, length: 1, offset: null })).toThrow();
  io.exit(0);
  expect(messages).toEqual([{ kind: "exit", identity, code: 0 }]);
});

it("keeps logical output alive between the last acknowledgement and its continuation", async () => {
  const io = new ProcessIO(identity, createMailbox(), () => {});
  const write = io.output("stdout", Uint8Array.of(1));
  io.receive({ kind: "reply", identity, bytes: encodeAssistanceReply({ ...identity, result: { kind: "unit" } }) });
  expect(() => io.exit(0)).toThrow("pending I/O");
  await write;
  await io.drain();
  expect(() => io.exit(0)).not.toThrow();
});

it("continues the startup command sequence after a broker reservation", async () => {
  const sent: unknown[] = [];
  const io = new ProcessIO({ ...identity, sequence: 2 }, createMailbox(), event => { sent.push(event); });
  io.setInput(async () => {});
  io.ready();
  expect(() => io.receive({ kind: "input", identity: { ...identity, sequence: 3 }, bytes: null })).not.toThrow();
  await Promise.resolve();
  expect(sent).toContainEqual({ kind: "input-ack", identity: { ...identity, sequence: 2 }, sequence: 3 });
});


it("keeps idle exit strict while explicit exit can retire outstanding activity", () => {
  const send = vi.fn();
  const io = new ProcessIO(identity, createMailbox(), send);
  const release = io.retain();
  expect(() => io.exit(7)).toThrow("pending I/O");
  io.exit(7, true);
  expect(send).toHaveBeenCalledWith({ kind: "exit-request", identity, code: 7 });
  release();
  io.close(new Error("test cleanup"));
});


it("accounts unreferenced socket reads without keeping the process alive", async () => {
  const messages: Extract<BrokerEvent, { kind: "request" }>[] = [];
  const io = new ProcessIO(identity, createMailbox(), event => { if (event.kind === "request") messages.push(event); });
  const release = io.retain();
  const read = io.call({ kind: "socket-read", fd: 1, length: 16 }, false);
  expect(io.hasPending).toBe(true);
  release();
  expect(io.hasPending).toBe(false);
  await io.drain();
  const request = messages[0];
  if (request === undefined) throw new Error("missing read");
  io.receive({ kind: "reply", identity: request.identity,
    bytes: encodeAssistanceReply({ ...request.identity, result: { kind: "data", bytes: Uint8Array.of(7) } }, 7) });
  await expect(read).resolves.toEqual({ kind: "data", bytes: Uint8Array.of(7) });
  expect(io.hasPending).toBe(false);
  io.close(new Error("cleanup"));
});

it("delivers broker completions through separate process turns", async () => {
  const messages: Extract<BrokerEvent, { kind: "request" }>[] = [];
  const io = new ProcessIO(identity, createMailbox(), event => { if (event.kind === "request") messages.push(event); });
  const scheduler = new ProcessScheduler(createAsyncContext(), error => io.fail(error));
  io.setCallbackScheduler(callback => scheduler.enqueue(callback));
  const order: string[] = [];
  const first = io.call({ kind: "close", fd: 3 }).then(() => {
    order.push("first"); scheduler.nextTick(() => order.push("tick"));
    return Promise.resolve().then(() => order.push("promise"));
  });
  const second = io.call({ kind: "close", fd: 4 }).then(() => order.push("second"));
  try {
    for (const message of messages) io.receive({ kind: "reply", identity: message.identity,
      bytes: encodeAssistanceReply({ ...message.identity, result: { kind: "unit" } }) });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "promise", "tick", "second"]);
  } finally { scheduler.dispose(); io.close(new Error("cleanup")); }
});

it("forks synchronously through the mailbox and decodes control's reply", async () => {
  const { takeRequest, completeReply } = await import("./mailbox.ts");
  const { decodeForkRequestBytes, encodeForkReply } = await import("../../protocol/assistance-fork.ts");
  const buffer = createMailbox();
  const request = { entry: "/workspace/child.js", args: ["x"], execArgv: [], cwd: "/workspace", env: { A: "1" }, silent: true };
  const seen: unknown[] = [];
  const io = new ProcessIO(identity, buffer, event => {
    seen.push(event);
    if (event.kind === "pending-fork") {
      expect(decodeForkRequestBytes(takeRequest(buffer, event.identity.sequence))).toEqual(request);
      completeReply(buffer, event.identity.sequence, encodeForkReply({ kind: "spawned", process: 2, pid: 40 }));
    }
  });
  expect(io.forkSync(request)).toEqual({ kind: "spawned", process: 2, pid: 40 });
  expect(seen).toEqual([{ kind: "pending-fork", identity }]);
  expect(() => io.forkSync({ ...request, entry: "child.js" })).toThrow();
  io.close(new Error("cleanup"));
});

it("carries fork traffic on the parent's identity and settles it with unit or error replies", async () => {
  const messages: unknown[] = [];
  const io = new ProcessIO(identity, createMailbox(), value => { messages.push(value); });
  const input = io.forkInput(2, Uint8Array.of(1));
  expect(messages).toEqual([{ kind: "fork-input", identity, child: 2, bytes: Uint8Array.of(1) }]);
  io.receive({ kind: "reply", identity, bytes: encodeAssistanceReply({ ...identity, result: { kind: "unit" } }) });
  await expect(input).resolves.toEqual({ kind: "unit" });
  const signal = io.forkSignal(2, "TERM");
  const second = { ...identity, sequence: 2 };
  expect(messages.at(-1)).toEqual({ kind: "fork-signal", identity: second, child: 2, signal: "TERM" });
  const error = { kind: "error", errno: 3, code: "ESRCH", syscall: "kill", path: null, destination: null } as const;
  io.receive({ kind: "reply", identity: second, bytes: encodeAssistanceReply({ ...second, result: error }) });
  await expect(signal).resolves.toEqual(error);
  io.forkOutputAck(2, 7);
  expect(messages.at(-1)).toEqual({ kind: "fork-output-ack", identity: { ...identity, sequence: 3 }, child: 2, chunk: 7 });
  expect(io.hasPending).toBe(false);
  await io.drain();
  io.close(new Error("cleanup"));
});

it("routes fork commands to their owners in command order and hands over private channels", () => {
  const io = new ProcessIO({ ...identity, sequence: 2 }, createMailbox(), () => {});
  const seen: unknown[] = [];
  io.setForkEvents({
    channel: (child, port) => { seen.push(["channel", child, port instanceof MessagePort]); port.close(); },
    output: (child, stream, bytes, chunk) => { seen.push(["output", child, stream, bytes, chunk]); },
    exit: (child, termination) => { seen.push(["exit", child, termination]); },
  });
  io.setSignals(signal => { seen.push(["signal", signal]); });
  const { port1 } = new MessageChannel();
  io.receive({ kind: "fork-channel", identity: { ...identity, sequence: 2 }, child: 3, port: port1 });
  io.receive({ kind: "fork-output", identity: { ...identity, sequence: 3 }, child: 3, stream: "stderr", bytes: Uint8Array.of(9), chunk: 1 });
  expect(() => io.receive({ kind: "fork-exit", identity: { ...identity, sequence: 3 }, child: 3, termination: { kind: "exit", code: 0 } })).toThrow();
  io.receive({ kind: "signal", identity: { ...identity, sequence: 4 }, signal: "INT" });
  io.receive({ kind: "fork-exit", identity: { ...identity, sequence: 5 }, child: 3, termination: { kind: "signal", signal: 9 } });
  expect(seen).toEqual([
    ["channel", 3, true], ["output", 3, "stderr", Uint8Array.of(9), 1], ["signal", "INT"], ["exit", 3, { kind: "signal", signal: 9 }],
  ]);
  const send = vi.fn();
  const ending = new ProcessIO(identity, createMailbox(), send);
  ending.signalExit(15);
  expect(send).toHaveBeenCalledWith({ kind: "exit-signal", identity, signal: 15 });
  io.close(new Error("cleanup")); ending.close(new Error("cleanup"));
});

/** An uncaught error ends the process with a failure event whose message alone
 * cannot locate the fault; the event keeps a bounded stack beside it. */
it("keeps a bounded stack of an uncaught error in its failure event", () => {
  const sent: unknown[] = [];
  const io = new ProcessIO(identity, createMailbox(), value => { sent.push(value); });
  const error = new TypeError("Cannot read properties of undefined (reading 'bind')");
  error.stack = `TypeError: Cannot read properties of undefined (reading 'bind')\n    at start (/workspace/phase34-app/node_modules/next/dist/server/lib/start-server.js:12:3)\n${"    at frame (/x.js:1:1)\n".repeat(400)}`;
  io.fail(error);
  const failed = sent.find((value): value is { kind: "failed"; error: { code: string; message: string; detail?: Record<string, unknown> } } =>
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "failed");
  expect(failed?.error.code).toBe("PROTOCOL_ERROR");
  expect(failed?.error.message).toBe("Cannot read properties of undefined (reading 'bind')");
  const stack = failed?.error.detail?.["stack"];
  if (typeof stack !== "string") throw new Error("failure event has no stack");
  expect(stack).toContain("start-server.js:12:3");
  expect(stack.length).toBeLessThanOrEqual(4096);
});
