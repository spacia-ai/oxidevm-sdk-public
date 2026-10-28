import { expect, it, vi } from "vitest";
import { Buffer } from "buffer";
import { createForkedChildren } from "./node-fork.ts";
import { createAsyncContext } from "./async-context.ts";
import type { ForkEvents } from "./process-io.ts";
import type { ForkReply, ForkRequest } from "../../protocol/assistance-fork.ts";
import type { AssistanceResult } from "../../protocol/assistance-reply.ts";
import type { ChildSignal } from "../../protocol/assistance-broker.ts";

function harness(reply: ForkReply = { kind: "spawned", process: 2, pid: 40 }, execPath?: string, signalReply?: AssistanceResult) {
  const requests: ForkRequest[] = [];
  const signals: [number, ChildSignal][] = [];
  const inputs: [number, Uint8Array | null][] = [];
  const acknowledged: [number, number][] = [];
  let events: ForkEvents | undefined;
  const io = {
    forkSync(request: ForkRequest): ForkReply { requests.push(request); return reply; },
    forkInput(child: number, bytes: Uint8Array<ArrayBuffer> | null): Promise<AssistanceResult> { inputs.push([child, bytes]); return Promise.resolve({ kind: "unit" }); },
    forkSignal(child: number, signal: ChildSignal): AssistanceResult | Promise<AssistanceResult> { signals.push([child, signal]); return signalReply ?? Promise.resolve({ kind: "unit" }); },
    forkOutputAck(child: number, chunk: number): void { acknowledged.push([child, chunk]); },
    setForkEvents(receive: ForkEvents): void { events = receive; },
  };
  const runtime = createForkedChildren(io, createAsyncContext(), { HOME: "/home", NODE_OPTIONS: "--enable-source-maps" }, () => "/workspace/app", ["--enable-source-maps"], execPath === undefined ? {} : { execPath });
  const drive = () => { if (events === undefined) throw new Error("fork events not installed"); return events; };
  return { runtime, requests, signals, inputs, acknowledged, drive };
}

it("returns Linux's synchronous kill result and ignores an already exited child", () => {
  const errors = vi.fn();
  const missing = harness(undefined, "/usr/bin/node", { kind: "error", errno: 3, code: "ESRCH", syscall: "signal", path: null, destination: null }).runtime.fork("./worker.js");
  missing.on("error", errors);
  expect(missing.kill()).toBe(false);
  expect(missing.killed).toBe(false);
  expect(errors).not.toHaveBeenCalled();
  const running = harness(undefined, "/usr/bin/node", { kind: "unit" }).runtime.fork("./worker.js");
  expect(running.kill()).toBe(true); expect(running.killed).toBe(true);
});

it("preserves the selected runtime executable for forked processes", () => {
  const { runtime } = harness(undefined, "/usr/local/bin/bun");
  const child = runtime.fork("./server.js", { execPath: "/usr/local/bin/bun" });
  expect(child.spawnfile).toBe("/usr/local/bin/bun");
  expect(child.spawnargs[0]).toBe("/usr/local/bin/bun");
});

it("normalizes a fork environment like Node: undefined values are dropped, others stringified, null bytes refused", () => {
  const { runtime, requests } = harness();
  // Next's dev CLI spreads process.env and adds keys whose values may be
  // undefined (TURBOPACK, NODE_EXTRA_CA_CERTS); Node's spawn skips them.
  runtime.fork("./server.js", { silent: true, env: { TURBOPACK: undefined, PORT: 3000, FLAG: true, NAME: "next" } });
  expect(requests[0]?.env).toEqual({ PORT: "3000", FLAG: "true", NAME: "next" });
  expect(() => runtime.fork("./server.js", { env: { BAD: "a\0b" } })).toThrow(/null bytes/u);
  expect(() => runtime.fork("./server.js", { env: "PATH=/bin" })).toThrow(/options\.env/u);
});

it("forks with the resolved entry, inherited execArgv and env, and reports the child's pid synchronously", () => {
  const { runtime, requests } = harness();
  const child = runtime.fork("./server.js", ["--port", "3000"], { silent: true, env: { A: "1" } });
  expect(child.pid).toBe(40);
  expect(child.connected).toBe(false);
  expect(child.exitCode).toBeNull();
  expect(requests).toEqual([{ entry: "/workspace/app/server.js", args: ["--port", "3000"], execArgv: ["--enable-source-maps"], cwd: "/workspace/app", env: { A: "1" }, silent: true }]);
  const inherit = runtime.fork("/abs/child.js", { cwd: "/workspace", execArgv: [], stdio: "inherit" });
  expect(requests[1]).toEqual({ entry: "/abs/child.js", args: [], execArgv: [], cwd: "/workspace", env: { HOME: "/home", NODE_OPTIONS: "--enable-source-maps" }, silent: false });
  expect(inherit.stdout).toBeNull(); expect(inherit.stdin).toBeNull();
  expect(child.stdout).not.toBeNull();
  expect(child.spawnargs).toEqual(["/usr/local/bin/oxidevm-node", "/workspace/app/server.js", "--port", "3000"]);
  for (const options of [{ serialization: "advanced" }, { execPath: "/usr/bin/node" }, { stdio: ["pipe", "pipe", "pipe"] }, { stdio: ["ignore", "pipe", "pipe", "ipc"] }, { uid: 0 }, { execArgv: ["--inspect"] }]) {
    expect(() => runtime.fork("./x.js", options)).toThrow();
  }
  expect(runtime.hasPending).toBe(true);
});

it("queues messages until the private channel arrives, then delivers replies and keeps the parent alive while listened", async () => {
  const { runtime, drive } = harness();
  const child = runtime.fork("./worker.js", { silent: true });
  const sent = vi.fn();
  expect(child.send({ hello: 1 }, sent)).toBe(true);
  const { port1, port2 } = new MessageChannel();
  const received = new Promise<unknown>(resolve => { port2.onmessage = event => resolve(event.data); });
  drive().channel(2, port1);
  expect(child.connected).toBe(true);
  await expect(received).resolves.toEqual({ message: JSON.stringify({ hello: 1 }) });
  port2.postMessage({ ack: new TextEncoder().encode(JSON.stringify({ hello: 1 })).byteLength });
  await vi.waitFor(() => expect(sent).toHaveBeenCalledWith(null));
  const messages: unknown[] = [];
  child.on("message", value => messages.push(value));
  port2.postMessage({ message: JSON.stringify({ ready: true }) });
  await vi.waitFor(() => expect(messages).toEqual([{ ready: true }]));
  const disconnected = vi.fn();
  child.on("disconnect", disconnected);
  child.disconnect();
  expect(child.connected).toBe(false);
  await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
  port2.close();
});

it("routes silent output with acknowledgements, signals, stdin and termination in Node's order", async () => {
  const { runtime, drive, signals, inputs, acknowledged } = harness();
  const child = runtime.fork("./worker.js", { silent: true });
  const order: string[] = [];
  const chunks: unknown[] = [];
  child.stdout?.on("data", value => { chunks.push(value); });
  child.stderr?.on("end", () => { order.push("stderr-end"); });
  child.on("exit", (code, signal) => { order.push(`exit:${String(code)}:${String(signal)}`); });
  const closed = Promise.withResolvers<[unknown, unknown]>();
  child.on("close", (code, signal) => { order.push("close"); closed.resolve([code, signal]); });
  drive().output(2, "stdout", Uint8Array.of(65), 1);
  await vi.waitFor(() => expect(acknowledged).toEqual([[2, 1]]));
  await vi.waitFor(() => expect(chunks).toEqual([Buffer.from([65])]));
  const written = Promise.withResolvers<undefined>();
  child.stdin?.write("in", error => { if (error) written.reject(error); else written.resolve(undefined); });
  await written.promise;
  expect(inputs.map(([child, bytes]) => [child, bytes === null ? null : [...bytes]])).toEqual([[2, [105, 110]]]);
  expect(child.kill()).toBe(true);
  expect(child.killed).toBe(true);
  await vi.waitFor(() => expect(signals).toEqual([[2, "TERM"]]));
  expect(child.kill("SIGKILL")).toBe(true);
  await vi.waitFor(() => expect(signals).toEqual([[2, "TERM"], [2, "KILL"]]));
  expect(() => child.kill("SIGUSR1")).toThrow();
  drive().exit(2, { kind: "signal", signal: 9 });
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBe("SIGKILL");
  expect(await closed.promise).toEqual([null, "SIGKILL"]);
  expect(order).toEqual(["exit:null:SIGKILL", "stderr-end", "close"]);
  expect(child.kill()).toBe(false);
  await runtime.idle();
  expect(runtime.hasPending).toBe(false);
});

it("reports a refused fork as an asynchronous error followed by close", async () => {
  const { runtime } = harness({ kind: "error", errno: 11, code: "EAGAIN" });
  const child = runtime.fork("./worker.js");
  expect(child.pid).toBeUndefined();
  const failure = Promise.withResolvers<unknown>();
  child.on("error", error => failure.resolve(error));
  const closed = Promise.withResolvers<unknown[]>();
  child.on("close", (code, signal) => closed.resolve([code, signal]));
  await expect(failure.promise).resolves.toMatchObject({ code: "EAGAIN", errno: -11, syscall: "spawn /usr/local/bin/oxidevm-node" });
  expect(await closed.promise).toEqual([-11, null]);
  expect(runtime.hasPending).toBe(false);
});

it("delivers an inherited child's exit without streams and an error termination as an error event", async () => {
  const { runtime, drive } = harness();
  const child = runtime.fork("./worker.js");
  const closed = Promise.withResolvers<unknown[]>();
  child.on("close", (code, signal) => closed.resolve([code, signal]));
  drive().exit(2, { kind: "exit", code: 77 });
  expect(await closed.promise).toEqual([77, null]);
  expect(child.exitCode).toBe(77);
  const failing = runtime.fork("./worker.js");
  const failure = Promise.withResolvers<unknown>();
  failing.on("error", error => failure.resolve(error));
  drive().exit(2, { kind: "error", error: { code: "GUEST_CRASH", message: "lost" } });
  await expect(failure.promise).resolves.toMatchObject({ message: "lost" });
});
