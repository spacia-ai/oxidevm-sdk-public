import { REGISTRY_PROTOCOL_VERSION } from "../protocol/registry.js";
import { afterEach, expect, it, vi } from "vitest";
import { RegistryChannel } from "./registry-channel.js";
import { decodeRegistryReply } from "../protocol/registry.js";
import { GrantedTraffic } from "./assistance/traffic.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";

afterEach(() => vi.unstubAllGlobals());
const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1 };

function fixture(lifetime = new AbortController(), controlBytes = 64 * 1024) {
  const budget = new AssistanceTraffic(6);
  const identity = { session: binding.session, generation: binding.generation, producer: "network" as const, process: null };
  const grants = [budget.grant({ ...identity, pool: "data", bytes: 1024 * 1024, entries: 16 }),
    budget.grant({ ...identity, pool: "control", bytes: controlBytes, entries: 32 })];
  const ports = new MessageChannel();
  const replies: unknown[] = [];
  let wake: (() => void) | undefined;
  ports.port2.onmessage = (event: MessageEvent<unknown>) => { replies.push(event.data); wake?.(); };
  const traffic = new GrantedTraffic(identity, grants, 6);
  const channel = new RegistryChannel(ports.port1, binding, traffic, {
    origin: "https://registry.npmjs.org", maximumBytes: 1024 * 1024,
  }, lifetime.signal);
  return { channel, budget, traffic, lifetime, sender: ports.port1, port: ports.port2,
    send(sequence: number, payload: Record<string, unknown>) {
      ports.port2.postMessage({ version: REGISTRY_PROTOCOL_VERSION, ...binding, sequence, ...payload });
    },
    async receive() {
      if (replies.length === 0) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      return decodeRegistryReply(replies.shift());
    },
  };
}

it.each([31, 32] as const)("retains registry dialect %s through headers and retirement", async version => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  try {
    f.send(1, { version, kind: "start", url: "https://registry.npmjs.org/react",
      ...(version === 32 ? { representation: "install" } : {}) });
    expect(await f.receive()).toMatchObject({ version, kind: "started" });
    expect(await f.receive()).toMatchObject({ version, kind: "headers" });
    expect(fetcher).toHaveBeenCalledWith("https://registry.npmjs.org/react", expect.objectContaining({
      headers: { accept: version === 32 ? "application/vnd.npm.install-v1+json" : "application/json" },
    }));
    f.send(2, { version, kind: "retire" });
    const retired = await f.receive();
    expect(retired).toMatchObject({ version, kind: "retired" });
    if (version === 32) expect(retired).toMatchObject({ profile: { requests: 1, bytes: 0 } });
    else expect(retired).not.toHaveProperty("profile");
    await f.channel.done;
  } finally { f.port.close(); }
});

it("rejects a registry dialect switch on an authenticated channel", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
  const f = fixture();
  const failure = expect(f.channel.done).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  f.send(1, { version: 31, kind: "start", url: "https://registry.npmjs.org/react" });
  await f.receive(); await f.receive();
  f.send(2, { version: 32, kind: "retire" });
  try { await failure; } finally { f.port.close(); }
});

it("fences commands beyond the gateway concurrency bound while data is occupied", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  })));
  const f = fixture(new AbortController(), 256 * 1024);
  const failure = expect(f.channel.done).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", message: "Registry command capacity exhausted" });
  for (let sequence = 1; sequence <= 5; sequence++) f.send(sequence, { kind: "start", url: "https://registry.npmjs.org/pkg" });
  try { await failure; }
  finally { f.port.close(); }
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
});

it("fences owner loss during fetch startup and awaits late response cleanup", async () => {
  const pending = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => {
    signal = init?.signal;
    return pending.promise;
  }));
  const f = fixture();
  const outcome = f.channel.done.then(() => undefined, (error: unknown) => error);
  let completed = false;
  void f.channel.done.then(() => { completed = true; }, () => { completed = true; });
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  await f.receive();
  f.lifetime.abort();
  const cancel = vi.fn();
  try {
    expect(signal?.aborted).toBe(true);
    expect(completed).toBe(false);
    expect(f.budget.pendingBytes).toBeGreaterThan(0);
  } finally {
    pending.resolve(new Response(new ReadableStream({ type: "bytes", cancel })));
    f.send(2, { kind: "retire" });
    f.port.close();
  }
  expect(await outcome).toMatchObject({ code: "RELAY_ERROR" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
});

it("fences a failed early identity transfer instead of sending further replies", async () => {
  const aborted = vi.fn();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted(); reject(new Error("aborted")); }, { once: true });
  })));
  const f = fixture();
  const send = vi.spyOn(f.sender, "postMessage").mockImplementationOnce(() => { throw new Error("transfer failed"); });
  const outcome = f.channel.done.then(() => undefined, (error: unknown) => error);
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  try { await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce()); }
  finally { f.send(2, { kind: "retire" }); }
  expect(await outcome).toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(send).toHaveBeenCalledOnce();
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.port.close();
});

it("rejects an already lost owner before accepting requests", async () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
  const lifetime = new AbortController(); lifetime.abort();
  const f = fixture(lifetime);
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  await expect(f.channel.done).rejects.toMatchObject({ code: "RELAY_ERROR" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.port.close();
});

it("retains the grant when owner-loss cleanup fails", async () => {
  const cancel = vi.fn(() => Promise.reject(new Error("upstream cleanup failed")));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ type: "bytes", cancel }))));
  const f = fixture();
  const rejected = expect(f.channel.done).rejects.toMatchObject({ code: "RELAY_ERROR", message: "Registry response cleanup failed" });
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  await f.receive(); await f.receive();
  f.lifetime.abort();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.port.close();
});

it("does not return credits if the owner disappears during retirement", async () => {
  const cancelling = Promise.withResolvers<undefined>();
  const cleanup = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    type: "bytes", cancel() { cancelling.resolve(undefined); return cleanup.promise; },
  }))));
  const f = fixture();
  const sent = vi.spyOn(f.sender, "postMessage");
  const rejected = expect(f.channel.done).rejects.toMatchObject({ code: "RELAY_ERROR" });
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  await f.receive(); await f.receive();
  f.send(2, { kind: "retire" });
  await cancelling.promise;
  f.lifetime.abort();
  cleanup.resolve(undefined);
  await rejected;
  expect(sent).toHaveBeenCalledTimes(2);
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.port.close();
});

it("streams real MessagePort replies against issued credit and returns the window after retirement", async () => {
  let sent = false;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    type: "bytes", pull(stream) {
      if (!sent) { sent = true; stream.enqueue(new Uint8Array([4, 5])); }
      else { stream.close(); stream.byobRequest?.respond(0); }
    },
  }))));
  const f = fixture();
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  const started = await f.receive();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("missing request identity");
  const head = await f.receive();
  if (head.kind !== "headers") throw new Error("missing headers");
  expect(head.sequence).toBeGreaterThan(started.sequence);
  expect(head.correlation).toBe(started.correlation);
  f.send(2, { kind: "acknowledge", request: started.request, reservation: head.reservation });
  f.send(3, { kind: "read", request: started.request });
  const data = await f.receive();
  if (data.kind !== "data") throw new Error("missing body");
  expect(data.bytes).toEqual(new Uint8Array([4, 5]));
  expect(data.bytes.buffer.byteLength).toBe(2);
  f.send(4, { kind: "acknowledge", request: started.request, reservation: data.reservation });
  f.send(5, { kind: "cancel", request: started.request });
  expect((await f.receive()).kind).toBe("cancelled");
  f.send(6, { kind: "retire" });
  const retired = await f.receive();
  if (retired.kind !== "retired") throw new Error("missing grant return");
  for (const credit of retired.credits) f.budget.returnCredit(credit);
  await f.channel.done;
  expect(f.budget.pendingBytes).toBe(0);
  f.port.close();
});

it("cancels an opening fetch through its early wire identity", async () => {
  const pending = Promise.withResolvers<Response>();
  const aborted = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => {
    init?.signal?.addEventListener("abort", () => aborted.resolve(undefined), { once: true });
    return pending.promise;
  }));
  const f = fixture();
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  const started = await f.receive();
  if (started.kind !== "started") throw new Error("missing early request identity");
  // Headers and the fixed command window already own 576 KiB. Fill the remaining
  // data window; cancellation must use the reserved control capacity.
  const occupied = f.traffic.reserve("data", 448 * 1024);
  f.send(2, { kind: "cancel", request: started.request });
  await aborted.promise;
  const cancel = vi.fn();
  pending.resolve(new Response(new ReadableStream({ type: "bytes", cancel })));
  const replies = [await f.receive(), await f.receive()];
  expect(replies.map(reply => reply.kind).sort()).toEqual(["cancelled", "failure"]);
  expect(replies.find(reply => reply.kind === "failure")).toMatchObject({ correlation: 1, error: { code: "ABORTED" } });
  expect(replies.find(reply => reply.kind === "cancelled")).toMatchObject({ correlation: 2 });
  expect(cancel).toHaveBeenCalledOnce();
  f.traffic.release(occupied);
  f.send(3, { kind: "retire" });
  const retired = await f.receive();
  if (retired.kind !== "retired") throw new Error("missing retirement");
  for (const credit of retired.credits) f.budget.returnCredit(credit);
  await f.channel.done;
  expect(f.budget.pendingBytes).toBe(0);
  f.port.close();
});

it.each([
  { installation: 2 }, { generation: 2 }, { process: 1 }, { sequence: 0 }, { version: 30 },
])("fences a forged registry channel envelope %j before fetch", async extra => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  const rejected = expect(f.channel.done).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react", ...extra });
  await rejected;
  expect(fetcher).not.toHaveBeenCalled();
  // No return message can authorize reusing a failed connection's window.
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.port.close();
});

it("delivers retirement after cancelling an outstanding body reply", async () => {
  const reading = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    type: "bytes", pull() { reading.resolve(undefined); },
  }))));
  const f = fixture();
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  const started = await f.receive(); const head = await f.receive();
  if (started.kind !== "started" || head.kind !== "headers") throw new Error("missing startup replies");
  f.send(2, { kind: "acknowledge", request: started.request, reservation: head.reservation });
  f.send(3, { kind: "read", request: started.request });
  await reading.promise;
  f.send(4, { kind: "retire" });
  const retired = await f.receive();
  expect(retired.kind).toBe("retired");
  await f.channel.done;
  f.port.close();
});

it("retains control reply credit until its exact correlation and reservation are acknowledged", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("")));
  const f = fixture();
  const reserved = vi.spyOn(f.traffic, "reserve");
  const released = vi.spyOn(f.traffic, "release");
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  const started = await f.receive(); const headers = await f.receive();
  expect(started).toHaveProperty("reservation");
  if (started.kind !== "started") throw new Error("Missing control reservation");
  expect(reserved).toHaveBeenCalledWith("control", 16 * 1024);
  expect(released).not.toHaveBeenCalledWith(started.reservation);
  f.send(2, { kind: "acknowledge-control", correlation: started.correlation, reservation: started.reservation });
  await vi.waitFor(() => expect(released).toHaveBeenCalledWith(started.reservation));
  expect(headers.kind).toBe("headers");
  const rejected = expect(f.channel.done).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  f.send(3, { kind: "acknowledge-control", correlation: started.correlation, reservation: started.reservation });
  await rejected;
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.port.close();
});


it("fences unacknowledged control reply saturation without returning live credit", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("")));
  const f = fixture();
  const released = vi.spyOn(f.traffic, "release");
  const rejected = expect(f.channel.done).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  const started = await f.receive(); await f.receive();
  if (started.kind !== "started") throw new Error("missing identity");
  f.send(2, { kind: "cancel", request: started.request });
  const cancelled = await f.receive();
  if (cancelled.kind !== "cancelled") throw new Error("missing cancellation");
  f.send(3, { kind: "cancel", request: started.request });
  expect((await f.receive()).kind).toBe("cancelled");
  f.send(4, { kind: "cancel", request: started.request });
  await rejected;
  expect(released).not.toHaveBeenCalledWith(started.reservation);
  expect(released).not.toHaveBeenCalledWith(cancelled.reservation);
  expect(() => f.traffic.returns()).toThrow("buffers are still pending");
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.port.close();
});


it("does not release a control reservation for a different request correlation", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("")));
  const f = fixture();
  const released = vi.spyOn(f.traffic, "release");
  const rejected = expect(f.channel.done).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  const started = await f.receive(); await f.receive();
  if (started.kind !== "started") throw new Error("missing identity");
  f.send(2, { kind: "acknowledge-control", correlation: 2, reservation: started.reservation });
  await rejected;
  expect(released).not.toHaveBeenCalledWith(started.reservation);
  expect(() => f.traffic.returns()).toThrow("buffers are still pending");
  f.port.close();
});

it("retires through its supervisor after the installation receiver has gone away", async () => {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ type: "bytes",
    cancel() { entered.resolve(undefined); return released.promise; },
  }))));
  const f = fixture();
  f.send(1, { kind: "start", url: "https://registry.npmjs.org/react" });
  await f.receive(); await f.receive();
  f.port.close();
  let retired = false;
  const closing = f.channel.retire();
  expect(f.channel.retire()).toBe(closing);
  void closing.then(() => { retired = true; });
  await entered.promise;
  expect(retired).toBe(false);
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  released.resolve(undefined);
  const returned = await closing;
  await f.channel.done;
  for (const credit of returned) f.budget.returnCredit(credit);
  expect(f.budget.pendingBytes).toBe(0);
});
