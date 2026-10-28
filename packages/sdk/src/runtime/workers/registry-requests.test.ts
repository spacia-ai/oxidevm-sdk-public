import { afterEach, expect, it, vi } from "vitest";
import { RegistryRequests } from "./registry-requests.js";
import { GrantedTraffic } from "./assistance/traffic.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
const policy = { origin: "https://registry.npmjs.org", maximumBytes: 1024 * 1024 };

function setup(bytes = 1024 * 1024) {
  const budget = new AssistanceTraffic(6);
  const identity = { ...binding, producer: "network" as const, process: null };
  const grants = [budget.grant({ ...identity, pool: "data", bytes, entries: 16 }),
    budget.grant({ ...identity, pool: "control", bytes: 4096, entries: 16 })];
  const traffic = new GrantedTraffic(identity, grants, 6);
  return { budget, traffic, requests: new RegistryRequests(traffic, policy) };
}

function body(bytes: number[]) {
  let sent = false;
  return new Response(new ReadableStream({ type: "bytes", pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new Uint8Array(bytes)); }
    else { controller.close(); controller.byobRequest?.respond(0); }
  } }));
}

it("charges registry headers and chunks until exact acknowledgement and returns every grant", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(body([1, 2, 3])));
  const { requests, budget, traffic } = setup();
  const opened = await requests.start("https://registry.npmjs.org/react").response;
  expect(opened.status).toBe(200);
  await expect(requests.read(opened.request)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(() => requests.acknowledge(opened.request + 1, opened.reservation)).toThrow();
  requests.acknowledge(opened.request, opened.reservation);
  const chunk = await requests.read(opened.request);
  expect(chunk.bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(() => traffic.returns()).toThrow("pending");
  requests.acknowledge(opened.request, chunk.reservation);
  expect(() => requests.acknowledge(opened.request, chunk.reservation)).toThrow();
  const eof = await requests.read(opened.request);
  expect(eof.done).toBe(true);
  requests.acknowledge(opened.request, eof.reservation);
  const credits = traffic.returns();
  expect(credits).toHaveLength(2);
  await requests.cancel(opened.request);
  await requests.retire();
  for (const credit of credits) budget.returnCredit(credit);
  expect(budget.pendingBytes).toBe(0);
  expect(budget.pendingEntries).toBe(0);
});

it("waits before fetch under saturation and keeps cancellation independent of data credit", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(body([1])); vi.stubGlobal("fetch", fetcher);
  const { requests, traffic } = setup(512 * 1024);
  const full = traffic.reserve("data", 512 * 1024);
  const waiting = requests.start("https://registry.npmjs.org/react");
  const cancelled = expect(waiting.response).rejects.toMatchObject({ code: "ABORTED" });
  expect(fetcher).not.toHaveBeenCalled();
  await requests.cancel(waiting.request);
  await cancelled;
  traffic.release(full);
  const opened = await requests.start("https://registry.npmjs.org/react").response;
  await requests.cancel(opened.request);
  // Cancellation stops the producer, but the receiver still owns its header.
  expect(() => traffic.returns()).toThrow("pending");
  requests.acknowledge(opened.request, opened.reservation);
  await requests.retire();
  expect(traffic.returns()).toHaveLength(2);
});

it("retirement supervises late fetch completion", async () => {
  const waiting = Promise.withResolvers<Response>();
  const fetched = Promise.withResolvers<undefined>();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => { fetched.resolve(undefined); return waiting.promise; }); vi.stubGlobal("fetch", fetcher);
  const { requests, budget, traffic } = setup();
  const opened = requests.start("https://registry.npmjs.org/react").response;
  const rejected = expect(opened).rejects.toMatchObject({ code: "ABORTED" });
  await fetched.promise;
  const retiring = requests.retire();
  const cancel = vi.fn();
  waiting.resolve(new Response(new ReadableStream({ type: "bytes", cancel })));
  await rejected;
  await retiring;
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(cancel).toHaveBeenCalledOnce();
  expect(budget.pendingBytes).toBe(0);
  expect(requests.retire()).toBe(retiring);
  expect(() => requests.start("https://registry.npmjs.org/react")).toThrow("Registry transport retired");
});

it("cancels a body waiting for issued credit without allocating its buffer", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
  const { requests, traffic } = setup();
  const headers = await requests.start("https://registry.npmjs.org/react").response;
  requests.acknowledge(headers.request, headers.reservation);
  const full = traffic.reserve("data", 1024 * 1024);
  const reading = requests.read(headers.request);
  const cancelled = expect(reading).rejects.toMatchObject({ code: "ABORTED" });
  await expect(requests.read(headers.request)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await requests.cancel(headers.request);
  await cancelled;
  traffic.release(full);
  await requests.retire();
  expect(traffic.returns()).toHaveLength(2);
});

it("does not return credit while an interrupted upstream cannot be retired", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    type: "bytes", pull(controller) { controller.error(new Error("lost body")); },
  }))));
  const { requests, traffic } = setup();
  const opened = await requests.start("https://registry.npmjs.org/react").response;
  requests.acknowledge(opened.request, opened.reservation);
  await expect(requests.read(opened.request)).rejects.toMatchObject({ code: "RELAY_ERROR" });
  await expect(requests.retire()).rejects.toMatchObject({ code: "RELAY_ERROR" });
  expect(() => traffic.returns()).toThrow("pending");
});

it("cancels a blocked body read without ordinary data capacity", async () => {
  const pulled = Promise.withResolvers<undefined>();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    type: "bytes", pull() { pulled.resolve(undefined); }, cancel,
  }))));
  const { requests, budget, traffic } = setup();
  const opened = await requests.start("https://registry.npmjs.org/react").response;
  requests.acknowledge(opened.request, opened.reservation);
  const reading = requests.read(opened.request);
  const rejected = expect(reading).rejects.toMatchObject({ code: "ABORTED" });
  await pulled.promise;
  await requests.cancel(opened.request);
  await rejected;
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(cancel).toHaveBeenCalledOnce();
  expect(budget.pendingBytes).toBe(0);
});

it("reuses capacity after retirement without reusing request identities", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(body([1]))));
  const { requests, budget, traffic } = setup();
  let previous = 0;
  for (let index = 0; index < 32; index += 1) {
  const opened = await requests.start("https://registry.npmjs.org/react").response;
    expect(opened.request).toBeGreaterThan(previous);
    previous = opened.request;
    requests.acknowledge(opened.request, opened.reservation);
    const first = requests.cancel(opened.request);
    expect(requests.cancel(opened.request)).toBe(first);
    await first;
  }
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(budget.pendingBytes).toBe(0);
});

it("exposes cancellation identity before headers arrive without cancelling another request", async () => {
  const late = Promise.withResolvers<Response>();
  const fetched = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementationOnce(() => { fetched.resolve(undefined); return late.promise; }).mockResolvedValueOnce(body([7])));
  const { requests, budget, traffic } = setup();
  const first = requests.start("https://registry.npmjs.org/react");
  const rejected = expect(first.response).rejects.toMatchObject({ code: "ABORTED" });
  await fetched.promise;
  const cancelled = requests.cancel(first.request);
  const second = requests.start("https://registry.npmjs.org/events");
  const opened = await second.response;
  requests.acknowledge(second.request, opened.reservation);
  const chunk = await requests.read(second.request);
  expect(chunk.bytes).toEqual(new Uint8Array([7]));
  requests.acknowledge(second.request, chunk.reservation);
  const cancel = vi.fn();
  late.resolve(new Response(new ReadableStream({ type: "bytes", cancel })));
  await rejected;
  await cancelled;
  expect(cancel).toHaveBeenCalledOnce();
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(budget.pendingBytes).toBe(0);
});

it("accepts late cancellation after failed startup without cancelling a newer request", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(body([9])));
  const { requests, budget, traffic } = setup();
  const first = requests.start("https://registry.npmjs.org/react");
  await expect(first.response).rejects.toMatchObject({ code: "RELAY_ERROR" });
  await requests.cancel(first.request);
  const second = await requests.start("https://registry.npmjs.org/events").response;
  await requests.cancel(first.request);
  requests.acknowledge(second.request, second.reservation);
  const data = await requests.read(second.request);
  expect(data.bytes).toEqual(new Uint8Array([9]));
  requests.acknowledge(second.request, data.reservation);
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(budget.pendingBytes).toBe(0);
});

it("accepts duplicate cancellation after pruning a retired request but rejects never-issued identities", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(body([1]))));
  const { requests, budget, traffic } = setup();
  const first = await requests.start("https://registry.npmjs.org/react").response;
  requests.acknowledge(first.request, first.reservation);
  await requests.cancel(first.request);
  const second = await requests.start("https://registry.npmjs.org/events").response;
  await requests.cancel(first.request);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, second.request + 1]) {
    expect(() => requests.cancel(invalid)).toThrow("Unknown registry request");
  }
  expect(() => requests.acknowledge(first.request, first.reservation)).toThrow("Unknown registry request");
  requests.acknowledge(second.request, second.reservation);
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(budget.pendingBytes).toBe(0);
});

it.each(["headers", "body"] as const)("does not time out %s waiting for receive credit", async phase => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(body([1])));
  const { requests, traffic, budget } = setup();
  const opened = phase === "body" ? await requests.start("https://registry.npmjs.org/react").response : undefined;
  if (opened !== undefined) requests.acknowledge(opened.request, opened.reservation);
  const held = traffic.reserve("data", 1024 * 1024);
  const operation = opened === undefined ? requests.start("https://registry.npmjs.org/react").response : requests.read(opened.request);
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
  } finally { traffic.release(held); }
  const reply = await operation;
  requests.acknowledge(opened?.request ?? ("request" in reply ? reply.request : 0), reply.reservation);
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(budget.pendingBytes).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("times out registry acquisition while retaining ownership of a late upstream", async () => {
  vi.useFakeTimers();
  const late = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(late.promise));
  const { requests, budget, traffic } = setup();
  const started = requests.start("https://registry.npmjs.org/react");
  const rejected = expect(started.response).rejects.toMatchObject({ code: "RELAY_ERROR", detail: { phase: "headers" } });
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(() => traffic.returns()).toThrow("pending");
  const cancel = vi.fn();
  late.resolve(new Response(new ReadableStream({ type: "bytes", cancel })));
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(cancel).toHaveBeenCalledOnce();
  expect(budget.pendingBytes).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("times out stalled body reads but gives each progressing read its own idle budget", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  let count = 0;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    type: "bytes", pull(stream) { if (count++ < 2) stream.enqueue(new Uint8Array([1])); }, cancel,
  }))));
  const { requests, budget, traffic } = setup();
  const started = requests.start("https://registry.npmjs.org/react");
  const headers = await started.response;
  requests.acknowledge(started.request, headers.reservation);
  for (let index = 0; index < 2; index += 1) {
    await vi.advanceTimersByTimeAsync(59_000);
    const chunk = await requests.read(started.request);
    requests.acknowledge(started.request, chunk.reservation);
  }
  const rejected = expect(requests.read(started.request)).rejects.toMatchObject({ code: "RELAY_ERROR", detail: { phase: "body" } });
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  await requests.retire();
  for (const credit of traffic.returns()) budget.returnCredit(credit);
  expect(cancel).toHaveBeenCalledOnce();
  expect(budget.pendingBytes).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("fences a timed-out retirement instead of returning a live upstream's credits", async () => {
  vi.useFakeTimers();
  const late = Promise.withResolvers<Response>();
  const fetched = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => { fetched.resolve(undefined); return late.promise; }));
  const { requests, budget, traffic } = setup();
  const started = requests.start("https://registry.npmjs.org/react");
  const startup = expect(started.response).rejects.toMatchObject({ code: "RELAY_ERROR" });
  await fetched.promise;
  const retirement = requests.retire();
  const failed = expect(retirement).rejects.toMatchObject({ code: "RELAY_ERROR", detail: { phase: "retirement" } });
  await vi.advanceTimersByTimeAsync(60_000);
  await Promise.all([startup, failed]);
  expect(() => traffic.returns()).toThrow("pending");
  expect(budget.pendingBytes).toBeGreaterThan(0);
  const cancelled = Promise.withResolvers<undefined>();
  late.resolve(new Response(new ReadableStream({ type: "bytes", cancel() { cancelled.resolve(undefined); } })));
  await cancelled.promise;
  expect(requests.retire()).toBe(retirement);
  expect(budget.pendingBytes).toBeGreaterThan(0);
});

it("keeps concurrent metadata openings from consuming all credit before any fetch", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(body([1])));
  vi.stubGlobal("fetch", fetcher);
  const { traffic } = setup();
  const requests = new RegistryRequests(traffic, { ...policy, gatewayOrigin: "http://127.0.0.1:4097" });
  const openings = Array.from({ length: 8 }, (_, index) => requests.start(`https://registry.npmjs.org/package-${index}`));
  const responses = Promise.allSettled(openings.map(opening => opening.response));
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled(), { timeout: 100 });
    for (const opening of openings) {
      const header = await opening.response;
      requests.acknowledge(header.request, header.reservation);
      const chunk = await requests.read(header.request);
      expect(chunk.bytes).toEqual(new Uint8Array([1]));
      requests.acknowledge(header.request, chunk.reservation);
      const eof = await requests.read(header.request);
      expect(eof.done).toBe(true);
      requests.acknowledge(header.request, eof.reservation);
    }
    expect(fetcher).toHaveBeenCalledTimes(8);
  } finally {
    await requests.retire();
    await responses;
  }
  expect(traffic.returns()).toHaveLength(2);
});

it("attributes credit waits separately from upstream reads", async () => {
  let clock = 0;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => {
    let sent = false;
    return Promise.resolve(new Response(new ReadableStream({ type: "bytes", pull(controller) {
      if (!sent) { sent = true; clock += 30; controller.enqueue(new Uint8Array([1, 2, 3])); }
      else { controller.close(); controller.byobRequest?.respond(0); }
    } })));
  }));
  const budget = new AssistanceTraffic(6);
  const identity = { ...binding, producer: "network" as const, process: null };
  const traffic = new GrantedTraffic(identity, [budget.grant({ ...identity, pool: "data", bytes: 1024 * 1024, entries: 16 }),
    budget.grant({ ...identity, pool: "control", bytes: 4096, entries: 16 })], 6);
  const requests = new RegistryRequests(traffic, policy, () => clock);
  const full = traffic.reserve("data", 1024 * 1024);
  const waiting = requests.start("https://registry.npmjs.org/react");
  clock = 50;
  traffic.release(full);
  const opened = await waiting.response;
  requests.acknowledge(opened.request, opened.reservation);
  const chunk = await requests.read(opened.request);
  expect(chunk.bytes).toEqual(new Uint8Array([1, 2, 3]));
  requests.acknowledge(opened.request, chunk.reservation);
  expect(requests.profile()).toEqual({ requests: 1, bytes: 3, creditWaitMs: 50, upstreamMs: 30 });
  await requests.cancel(opened.request);
  await requests.retire();
});
