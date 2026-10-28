import { REGISTRY_PROTOCOL_VERSION } from "../protocol/registry.js";
import { decodeRegistryReply, decodeRegistryRequest } from "../protocol/registry.js";
import { registryVmBudget } from "./registry-transport.js";
import { expect, it, vi } from "vitest";
import { registryBytePipe, registryReplyPipe } from "./registry-pipe.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { encodeRegistryWire, decodeRegistryWire } from "../protocol/registry-wire.js";

const common = { version: REGISTRY_PROTOCOL_VERSION, session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 1 } as const;
it("carries registry frames across split native-pipe reads and bounded writes", async () => {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const written: Uint8Array[] = [];
  const traffic = new AssistanceTraffic(6);
  const pipe = registryBytePipe(input.readable, new WritableStream({ write(bytes: Uint8Array) { written.push(bytes); } }), registryVmBudget(traffic));
  const received = Promise.withResolvers<unknown>();
  const failed = vi.fn(); pipe.start(received.resolve, failed);
  const request = { ...common, kind: "retire" as const };
  pipe.send(request);
  const value = { ...common, kind: "started" as const, correlation: 1, request: 1, reservation: 2 };
  const payload = encodeRegistryWire(value, "reply");
  const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, payload.byteLength, true);
  const writer = input.writable.getWriter();
  await writer.write(prefix.slice(0, 1)); await writer.write(prefix.slice(1));
  await writer.write(payload.slice(0, 17)); await writer.write(payload.slice(17));
  expect(await received.promise).toEqual(value);
  pipe.close(); await pipe.done;
  const bytes = new Uint8Array(written.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of written) { expect(part.length).toBeLessThanOrEqual(4096); bytes.set(part, offset); offset += part.length; }
  expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(bytes.length - 4);
  expect(decodeRegistryWire(bytes.slice(4), "request")).toEqual(request);
  expect(traffic.pendingBytes).toBe(0); expect(failed).not.toHaveBeenCalled();
});
it("rejects oversized frame lengths before allocation and waits for independent retirement", async () => {
  const retirement = Promise.withResolvers<undefined>();
  const cancelled = vi.fn();
  const traffic = new AssistanceTraffic(6);
  const bad = new Uint8Array(4); new DataView(bad.buffer).setUint32(0, 131073, true);
  const pipe = registryBytePipe(new ReadableStream({ start(controller) { controller.enqueue(bad); }, cancel: cancelled }),
    new WritableStream({ abort() { return retirement.promise; } }), registryVmBudget(traffic));
  const failed = Promise.withResolvers<unknown>();
  pipe.start(() => { throw new Error("must not deliver malformed input"); }, failed.resolve);
  const done = expect(pipe.done).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await failed.promise;
  expect(cancelled).toHaveBeenCalledOnce(); expect(traffic.pendingBytes).toBeGreaterThan(0);
  retirement.resolve(undefined); await done; expect(traffic.pendingBytes).toBe(0);
});
it("bounds a slow pipe and retains reservations when retirement fails", async () => {
  const traffic = new AssistanceTraffic(6);
  const write = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const pipe = registryBytePipe(new ReadableStream(), new WritableStream({
    write() { started.resolve(undefined); return write.promise; }, abort() { throw new Error("uncertain writer retirement"); },
  }), registryVmBudget(traffic));
  pipe.start(() => {}, () => {});
  for (let sequence = 1; sequence <= 128; sequence++) pipe.send({ ...common, sequence, kind: "retire" });
  expect(() => pipe.send({ ...common, sequence: 129, kind: "retire" })).toThrow("queue");
  await started.promise;
  pipe.close(); const done = expect(pipe.done).rejects.toThrow("uncertain writer retirement");
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  write.resolve(undefined); await done; expect(traffic.pendingBytes).toBeGreaterThan(0);
});

it("runs the existing registry client and network owner through byte framing", async () => {
  const { RegistryClient } = await import("./registry-client.js");
  const { RegistryChannel } = await import("./registry-channel.js");
  const { GrantedTraffic } = await import("./assistance/traffic.js");
  const traffic = new AssistanceTraffic(6);
  const binding = { session: common.session, generation: common.generation, installation: common.installation };
  const identity = { session: common.session, generation: common.generation, producer: "network" as const, process: null };
  const grants = [traffic.grant({ ...identity, pool: "data", bytes: 1024 * 1024, entries: 16 }),
    traffic.grant({ ...identity, pool: "control", bytes: 128 * 1024, entries: 32 })];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([3, 1, 4]))));
  const ports = new MessageChannel();
  const server = new RegistryChannel(ports.port1, binding, new GrantedTraffic(identity, grants, 6),
    { origin: "https://registry.npmjs.org", maximumBytes: 1024 * 1024 }, new AbortController().signal);
  // Separate read/write retirement, as on the native pipes: cancelling a read
  // cannot retroactively reject a write whose bytes were already accepted.
  const requests = nativePipe();
  const replies = nativePipe();
  const failed = vi.fn();
  const returning = registryReplyPipe(requests.readable, replies.writable, registryVmBudget(traffic));
  returning.start(value => ports.port2.postMessage(decodeRegistryRequest(value)), failed);
  ports.port2.onmessage = (event: MessageEvent<unknown>) => {
    const reply = decodeRegistryReply(event.data);
    returning.send(reply);
    if (reply.kind === "retired") void returning.flush().then(() => returning.close()).catch(failed);
  };
  ports.port2.start();
  const pipe = registryBytePipe(replies.readable, requests.writable, registryVmBudget(traffic));
  const client = new RegistryClient(pipe, binding, registryVmBudget(traffic), grants, failed,
    returned => { for (const credit of returned) traffic.returnCredit(credit); });
  try {
    const start = client.start("https://registry.npmjs.org/example");
    const request = await start.identity;
    (await start.response).acknowledge();
    const body = await client.read(request); expect([...body.value.bytes]).toEqual([3, 1, 4]); body.acknowledge();
    const eof = await client.read(request); expect(eof.value.done).toBe(true); eof.acknowledge();
    await client.close(); await pipe.done; await server.done; await returning.done;
    expect(traffic.pendingBytes).toBe(0); expect(failed).not.toHaveBeenCalled();
  } finally { pipe.close(); returning.close(); ports.port1.close(); ports.port2.close(); vi.unstubAllGlobals(); }
});

it("does not deliver a frame whose final read races with pipe cancellation", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pulls = 0;
  const firstRead = Promise.withResolvers<undefined>();
  const bodyRead = Promise.withResolvers<undefined>();
  const input = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { pulls++; if (pulls === 1) firstRead.resolve(undefined); if (pulls === 2) bodyRead.resolve(undefined); },
  }, { highWaterMark: 0 });
  const traffic = new AssistanceTraffic(6);
  const pipe = registryBytePipe(input, new WritableStream(), registryVmBudget(traffic));
  const received = vi.fn(); pipe.start(received, () => {});
  const payload = encodeRegistryWire({ ...common, kind: "started", correlation: 1, request: 1, reservation: 2 }, "reply");
  const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, payload.length, true);
  if (controller === undefined) throw new Error("missing stream controller");
  await firstRead.promise; controller.enqueue(prefix);
  await bodyRead.promise;
  controller.enqueue(payload); pipe.close();
  await pipe.done;
  expect(received).not.toHaveBeenCalled(); expect(traffic.pendingBytes).toBe(0);
});


it("frames network replies with bounded immutable payload ownership", async () => {
  const traffic = new AssistanceTraffic(6);
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const written: Uint8Array[] = [];
  const pipe = registryReplyPipe(new ReadableStream(), new WritableStream({
    async write(bytes: Uint8Array) { started.resolve(undefined); await release.promise; written.push(bytes); },
  }), registryVmBudget(traffic));
  pipe.start(() => {}, () => {});
  const bytes = new Uint8Array([1, 2, 3]);
  pipe.send({ ...common, kind: "data", correlation: 1, request: 1, reservation: 1, bytes, done: false });
  bytes.fill(9);
  await started.promise;
  release.resolve(undefined);
  await pipe.flush();
  pipe.close(); await pipe.done;
  const framed = new Uint8Array(written.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of written) { framed.set(part, offset); offset += part.length; }
  expect(decodeRegistryWire(framed.slice(4), "reply")).toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
  expect(traffic.pendingBytes).toBe(0);
});


function nativePipe() {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const readable = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } },
    { highWaterMark: 65_536, size: bytes => bytes.byteLength });
  const writable = new WritableStream<Uint8Array>({ write(bytes) {
    if (source === undefined || (source.desiredSize ?? 0) < bytes.byteLength) throw new Error("Pipe capacity exhausted");
    source.enqueue(bytes);
  } });
  return { readable, writable };
}

it("bounds reply payloads while a writer is blocked and waits for retirement", async () => {
  const traffic = new AssistanceTraffic(6);
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const pipe = registryReplyPipe(new ReadableStream(), new WritableStream({
    write() { started.resolve(undefined); return release.promise; },
  }), registryVmBudget(traffic));
  pipe.start(() => {}, () => {});
  const reply = { ...common, kind: "data" as const, correlation: 1, request: 1, reservation: 1,
    bytes: new Uint8Array(65_536), done: false };
  for (let sequence = 1; sequence <= 7; sequence++) pipe.send({ ...reply, sequence });
  expect(() => pipe.send({ ...reply, sequence: 8 })).toThrow("queue");
  await started.promise;
  pipe.close();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  release.resolve(undefined);
  await pipe.done;
  expect(traffic.pendingBytes).toBe(0);
});

it("forwards the authenticated registry byte protocol without a second registry client", async () => {
  const { SystemNetworkChannel, SystemNetworkClient } = await import("./system-network-channel.js");
  const binding = { session: common.session, generation: common.generation };
  const { RegistryClient } = await import("./registry-client.js");
  const { registryBytePipe } = await import("./registry-pipe.js");
  const { GrantedTraffic } = await import("./assistance/traffic.js");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([3, 1, 4]))));
  const pair = new MessageChannel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  const endpoint = await client.openRegistryEndpoint(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  const gatewayIdentity = { ...binding, producer: "installation-gateway" as const, process: null };
  const grants = [traffic.grant({ ...gatewayIdentity, pool: "data", bytes: 6 * 1024 * 1024, entries: 256 }),
    traffic.grant({ ...gatewayIdentity, pool: "control", bytes: 256 * 1024, entries: 128 })];
  const gateway = new GrantedTraffic(gatewayIdentity, grants, 6);
  const requests = nativePipe();
  const replies = nativePipe();
  endpoint.forward(requests.readable, replies.writable);
  const pipe = registryBytePipe(replies.readable, requests.writable, gateway);
  const guest = new RegistryClient(pipe, { ...binding, installation: 1 }, gateway, endpoint.credits, failed, () => {});
  const head = await guest.start("https://registry.npmjs.org/example").response;
  head.acknowledge();
  const data = await guest.read(head.value.request);
  expect(data.value.bytes).toEqual(new Uint8Array([3, 1, 4]));
  data.acknowledge();
  await guest.close(); await pipe.done;
  await endpoint.close();
  for (const credit of gateway.returns()) traffic.returnCredit(credit);
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  server.close(); pair.port1.close(); pair.port2.close(); vi.unstubAllGlobals();
});

it("writes a reply frame as one coalesced prefixed write sequence in 64 KiB slices", async () => {
  const traffic = new AssistanceTraffic(6);
  const written: Uint8Array[] = [];
  const pipe = registryReplyPipe(new ReadableStream(), new WritableStream({ write(bytes: Uint8Array) { written.push(bytes); } }), registryVmBudget(traffic));
  pipe.start(() => {}, () => {});
  const reply = { ...common, kind: "data" as const, correlation: 1, request: 1, reservation: 1, bytes: new Uint8Array(65_536).fill(9), done: false };
  pipe.send(reply);
  await pipe.flush();
  // One 64 KiB guest write exchange per slice: the prefix rides with the frame and
  // slices fill the installation pipe's admitted 65,536-byte writes.
  expect(written.length).toBe(2);
  expect(written.every(part => part.length <= 65_536)).toBe(true);
  expect(written[0]?.length).toBe(65_536);
  const bytes = new Uint8Array(written.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of written) { bytes.set(part, offset); offset += part.length; }
  expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(bytes.length - 4);
  expect(decodeRegistryWire(bytes.slice(4), "reply")).toEqual(reply);
  pipe.close(); await pipe.done;
  expect(traffic.pendingBytes).toBe(0);
});
