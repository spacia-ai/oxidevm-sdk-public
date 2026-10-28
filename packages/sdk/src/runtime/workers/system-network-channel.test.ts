import { afterEach, expect, it, vi } from "vitest";
import { SystemNetworkChannel, SystemNetworkClient } from "./system-network-channel.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { decodeSystemNetworkMessage } from "../protocol/system-network.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
const ports: MessagePort[] = [];
afterEach(() => { vi.useRealTimers(); for (const port of ports.splice(0)) port.close(); });
function channel() {
  const pair = new MessageChannel(); ports.push(pair.port1, pair.port2);
  return pair;
}

it("does not publish registry startup after generation retirement begins", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const sent = pair.port1.postMessage.bind(pair.port1);
  const startup = Promise.withResolvers<unknown>();
  vi.spyOn(pair.port1, "postMessage").mockImplementation((value: unknown) => {
    const message = decodeSystemNetworkMessage(value);
    if (message.kind === "pong" && message.sequence === 2) startup.resolve(value);
    else sent(value);
  });
  const opening = client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  const reply = await startup.promise;
  const closing = client.close();
  sent(reply);
  await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  await closing;
  expect(traffic.pendingBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  server.close();
});

it("cancels installation acquisition before readiness without retiring the network generation", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  const cancellation = new AbortController();
  const opening = client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 }, cancellation.signal);
  cancellation.abort();
  await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  await client.ready;
  const registry = await client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  await registry.close();
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  server.close();
});

it("cancels a transferred installation and observes retirement before rejecting startup", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const baseline = traffic.pendingBytes;
  const sent = pair.port1.postMessage.bind(pair.port1);
  const startup = Promise.withResolvers<unknown>();
  vi.spyOn(pair.port1, "postMessage").mockImplementation((value: unknown) => {
    const message = decodeSystemNetworkMessage(value);
    if (message.kind === "pong" && message.sequence === 2) startup.resolve(value);
    else sent(value);
  });
  const cancellation = new AbortController();
  const opening = client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 }, cancellation.signal);
  const reply = await startup.promise;
  cancellation.abort();
  sent(reply);
  await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  expect(traffic.pendingBytes).toBe(baseline);
  await expect(client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 })).rejects.toBeDefined();
  const retry = await client.openRegistry(2, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  await retry.close();
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  server.close();
});

it("retains installation grants until abort finishes retiring its fetch producer", async () => {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ type: "bytes",
    cancel() { entered.resolve(undefined); return released.promise; },
  }))));
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  const cancellation = new AbortController();
  try {
    await client.ready;
    const baseline = traffic.pendingBytes;
    const registry = await client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 }, cancellation.signal);
    await registry.start("https://registry.npmjs.org/example").response;
    cancellation.abort();
    await entered.promise;
    expect(traffic.pendingBytes).toBeGreaterThan(baseline);
    await expect(client.openRegistry(2, { origin: "https://registry.npmjs.org", maximumBytes: 1024 })).rejects.toBeDefined();
    released.resolve(undefined);
    await registry.done;
    expect(traffic.pendingBytes).toBe(baseline);
    const retry = await client.openRegistry(2, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
    cancellation.abort();
    const headers = await retry.start("https://registry.npmjs.org/example").response;
    expect(headers.value.status).toBe(200);
    await retry.close();
  } finally {
    released.resolve(undefined);
    await client.close(); server.close(); vi.unstubAllGlobals();
  }
  expect(traffic.pendingBytes).toBe(0);
});

it("binds a real private network port and returns exact grants before rebinding", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  for (const generation of [1, 2]) {
    const client = new SystemNetworkClient(pair.port2, { ...binding, generation }, traffic, failed);
    await client.ready;
    expect(traffic.pendingBytes).toBeGreaterThan(0);
    const lifetime = server.signal;
    expect(lifetime?.aborted).toBe(false);
    const closing = client.close();
    expect(client.close()).toBe(closing);
    await closing;
    expect(lifetime?.aborted).toBe(true);
    expect(traffic.pendingBytes).toBe(0);
  }
  expect(failed).not.toHaveBeenCalled();
  server.close();
});

it("fences a silent network owner without returning live grants", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  pair.port1.onmessage = null;
  vi.useFakeTimers();
  // Start a retirement wait under the fake clock; a silent peer cannot finish it.
  const closing = expect(client.close()).rejects.toMatchObject({ code: "RELAY_ERROR" });
  await vi.advanceTimersByTimeAsync(60_000);
  await closing;
  expect(failed).toHaveBeenCalledOnce();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  server.close();
});

it("rejects malformed startup replies and keeps the window fenced", async () => {
  const pair = channel();
  pair.port1.onmessage = () => pair.port1.postMessage({ version: 30, kind: "pong", ...binding, sequence: 1 });
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await expect(client.ready).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(client.close()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(failed).toHaveBeenCalledOnce();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
});

it("aborts the network generation when its control owner disappears", async () => {
  vi.useFakeTimers();
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const failed = vi.fn();
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const lifetime = server.signal;
  const rejected = expect(server.done).rejects.toMatchObject({ code: "RELAY_ERROR" });
  pair.port2.close();
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(lifetime?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(client.close()).rejects.toMatchObject({ code: "RELAY_ERROR" });
  expect(traffic.pendingBytes).toBeGreaterThan(0);
});

it("connects installation registry traffic through the supervised network owner", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 })));
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  const registry = await client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  const head = await registry.start("https://registry.npmjs.org/example").response;
  expect(head.value.status).toBe(201);
  await client.close();
  await registry.done;
  expect(traffic.pendingBytes).toBe(0);
  server.close(); vi.unstubAllGlobals();
});

it("waits for registry producer cleanup before returning generation grants", async () => {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ type: "bytes",
    cancel() { entered.resolve(undefined); return released.promise; },
  }))));
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  const registry = await client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  await registry.start("https://registry.npmjs.org/example").response;
  let retired = false;
  const closing = client.close().then(() => { retired = true; });
  await entered.promise;
  expect(retired).toBe(false); expect(traffic.pendingBytes).toBeGreaterThan(0);
  released.resolve(undefined);
  await closing;
  expect(traffic.pendingBytes).toBe(0);
  server.close(); vi.unstubAllGlobals();
});

it("cancels a registry connection waiting for initial network readiness", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  const ready = expect(client.ready).rejects.toMatchObject({ code: "ABORTED" });
  const opening = expect(client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 })).rejects.toMatchObject({ code: "ABORTED" });
  await client.close(); await opening; await ready;
  expect(traffic.pendingBytes).toBe(0); server.close();
});

it("rejects invalid registry authority before transferring or retaining grants", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  await client.ready;
  const baseline = traffic.pendingBytes;
  await expect(client.openRegistry(1, { origin: "https://registry.npmjs.org/path", maximumBytes: 1024 })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(traffic.pendingBytes).toBe(baseline);
  const registry = await client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  await expect(client.openRegistry(2, { origin: "https://registry.npmjs.org", maximumBytes: 1024 })).rejects.toBeDefined();
  await registry.close();
  await expect(client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 })).rejects.toBeDefined();
  await client.close(); expect(traffic.pendingBytes).toBe(0); server.close();
});

it("fences both endpoints and retains grants after registry cleanup fails", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ type: "bytes",
    cancel() { return Promise.reject(new Error("cleanup failed")); },
  }))));
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  // The SDK forwards network-worker failure to control using this existing seam.
  const failedOwner = server.done.catch((error: unknown) => client.fail(error));
  const registry = await client.openRegistry(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  await registry.start("https://registry.npmjs.org/example").response;
  await expect(client.close()).rejects.toMatchObject({ code: "RELAY_ERROR" });
  await expect(registry.done).rejects.toMatchObject({ code: "RELAY_ERROR" });
  await failedOwner;
  expect(failed).toHaveBeenCalledOnce();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
  vi.unstubAllGlobals();
});

it("retires a guest registry independently after its receiving port is fenced", async () => {
  const { RegistryClient } = await import("./registry-client.js");
  const { registryMessagePort, registryVmBudget } = await import("./registry-transport.js");
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ type: "bytes",
    cancel() { entered.resolve(undefined); return released.promise; },
  }))));
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const baseline = traffic.pendingBytes;
  const endpoint = await client.openRegistryEndpoint(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  const guestBudget = new AssistanceTraffic(6);
  const guest = new RegistryClient(registryMessagePort(endpoint.port), { ...binding, installation: 1 },
    registryVmBudget(guestBudget), endpoint.credits, vi.fn(), () => {});
  await guest.start("https://registry.npmjs.org/example").response;
  guest.fail(new Error("guest gateway exited"));
  const closing = endpoint.close();
  expect(endpoint.close()).toBe(closing);
  await entered.promise;
  expect(traffic.pendingBytes).toBeGreaterThan(baseline);
  await expect(client.openRegistryEndpoint(2, { origin: "https://registry.npmjs.org", maximumBytes: 1024 })).rejects.toBeDefined();
  released.resolve(undefined);
  await closing;
  expect(traffic.pendingBytes).toBe(baseline);
  const retry = await client.openRegistryEndpoint(2, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  await retry.close();
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  server.close(); vi.unstubAllGlobals();
});

it("returns guest network grants once even when the gateway retires normally first", async () => {
  const { RegistryClient } = await import("./registry-client.js");
  const { registryMessagePort, registryVmBudget } = await import("./registry-transport.js");
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const baseline = traffic.pendingBytes;
  const endpoint = await client.openRegistryEndpoint(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  const guestBudget = new AssistanceTraffic(6);
  const returned = vi.fn();
  const guest = new RegistryClient(registryMessagePort(endpoint.port), { ...binding, installation: 1 },
    registryVmBudget(guestBudget), endpoint.credits, vi.fn(), returned);
  await guest.close();
  expect(returned).toHaveBeenCalledOnce();
  expect(guestBudget.pendingBytes).toBe(0);
  expect(traffic.pendingBytes).toBeGreaterThan(baseline);
  await endpoint.close();
  expect(traffic.pendingBytes).toBe(baseline);
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  server.close();
});

it("cancels guest registry startup through the supervisor before exposing its endpoint", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const baseline = traffic.pendingBytes;
  const sent = pair.port1.postMessage.bind(pair.port1);
  const startup = Promise.withResolvers<unknown>();
  vi.spyOn(pair.port1, "postMessage").mockImplementation((value: unknown) => {
    const message = decodeSystemNetworkMessage(value);
    if (message.kind === "pong" && message.sequence === 2) startup.resolve(value);
    else sent(value);
  });
  const abort = new AbortController();
  const opening = client.openRegistryEndpoint(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 }, abort.signal);
  const reply = await startup.promise;
  abort.abort();
  sent(reply);
  await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  expect(traffic.pendingBytes).toBe(baseline);
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  server.close();
});

it("rejects a forged guest registry retirement without returning any grants", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const endpoint = await client.openRegistryEndpoint(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 });
  const before = traffic.pendingBytes;
  const sent = pair.port1.postMessage.bind(pair.port1);
  vi.spyOn(pair.port1, "postMessage").mockImplementation((value: unknown) => {
    const message = decodeSystemNetworkMessage(value);
    sent(message.kind === "registry-retired" ? { ...message,
      credits: message.credits.map((credit, index) => index === 1 ? { ...credit, bytes: credit.bytes + 1 } : credit) } : message);
  });
  await expect(endpoint.close()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(traffic.pendingBytes).toBe(before);
  expect(failed).toHaveBeenCalledOnce();
  server.close();
});

it("waits for the Linux gateway port before admitting registry traffic", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(6);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  await client.ready;
  const baseline = traffic.pendingBytes;
  const ready = Promise.withResolvers<number>();
  const started = Promise.withResolvers<undefined>();
  const commands: unknown[] = [];
  const send = pair.port2.postMessage.bind(pair.port2);
  vi.spyOn(pair.port2, "postMessage").mockImplementation((message: unknown, options?: StructuredSerializeOptions) => {
    commands.push(message); send(message, options);
  });
  const opening = client.startRegistryGateway(1, { origin: "https://registry.npmjs.org", maximumBytes: 1024 }, credits => {
    expect(credits).toHaveLength(2);
    expect(credits.every(credit => credit.producer === "network" && credit.kind === "grant")).toBe(true);
    started.resolve(undefined);
    return ready.promise;
  });
  await started.promise;
  expect(commands).toHaveLength(0);
  ready.resolve(23456);
  const endpoint = await opening;
  expect(commands.map(decodeSystemNetworkMessage)).toEqual([expect.objectContaining({ kind: "registry-attach",
    policy: { origin: "https://registry.npmjs.org", maximumBytes: 1024, gatewayOrigin: "http://127.0.0.1:23456" } })]);
  await endpoint.close();
  expect(traffic.pendingBytes).toBe(baseline);
  await client.close(); server.close();
});

it("serializes concurrent listener updates and retires their task budgets", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(7);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  await client.ready;
  const baseline = traffic.pendingBytes;
  await Promise.all([1, 2, 3, 4].map(process => client.updateListener({ kind: "task-open", process })));
  await Promise.all([1, 2, 3, 4].flatMap(process => [1, 2, 3].map(fd => client.updateListener({
    kind: "listener-open", process, fd, address: { address: "127.0.0.1", port: 3000 + process * 10 + fd },
  }))));
  await client.updateListener({ kind: "listener-close", process: 1, fd: 2 });
  await Promise.all([1, 2, 3, 4].map(process => client.updateListener({ kind: "task-close", process })));
  expect(traffic.pendingBytes).toBe(baseline);
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  server.close();
});

it("rejects malformed listener updates without consuming the command sequence", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(7);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  await client.ready;
  await expect(client.updateListener({ kind: "task-open", process: 0 })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await client.updateListener({ kind: "task-open", process: 1 });
  await expect(client.updateListener({ kind: "listener-open", process: 1, fd: 1,
    address: { address: "localhost", port: 3000 } })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await client.updateListener({ kind: "task-close", process: 1 });
  await client.close();
  expect(traffic.pendingBytes).toBe(0);
  server.close();
});

it.each(["task-open", "listener-open"] as const)("rejects %s against retired task identity", async kind => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(7);
  const failed = vi.fn();
  const client = new SystemNetworkClient(pair.port2, binding, traffic, failed);
  // The worker composition reports channel loss to control; no lost producer's
  // credits may be claimed as returned merely because its port stopped replying.
  void server.done.catch((error: unknown) => client.fail(error));
  await client.ready;
  await client.updateListener({ kind: "task-open", process: 1 });
  await client.updateListener({ kind: "task-close", process: 1 });
  await expect(client.updateListener(kind === "task-open" ? { kind, process: 1 } : {
    kind, process: 1, fd: 1, address: { address: "127.0.0.1", port: 3000 },
  })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(client.close()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(failed).toHaveBeenCalledOnce();
  expect(traffic.pendingBytes).toBeGreaterThan(0);
});

it("revokes remaining logical listeners when their entire network generation retires", async () => {
  const pair = channel();
  const server = new SystemNetworkChannel(pair.port1);
  const traffic = new AssistanceTraffic(7);
  const client = new SystemNetworkClient(pair.port2, binding, traffic, vi.fn());
  await client.ready;
  const lifetime = server.signal;
  await client.updateListener({ kind: "task-open", process: 1 });
  await client.updateListener({ kind: "listener-open", process: 1, fd: 2, address: { address: "::", port: 3000 } });
  await client.close();
  expect(lifetime?.aborted).toBe(true);
  expect(traffic.pendingBytes).toBe(0);
  server.close();
});
