import { REGISTRY_PROTOCOL_VERSION } from "../protocol/registry.js";
import { registryMessagePort, registryVmBudget } from "./registry-transport.js";
import { afterEach, expect, it, vi } from "vitest";
import { RegistryClient } from "./registry-client.js";
import { RegistryChannel } from "./registry-channel.js";
import { GrantedTraffic } from "./assistance/traffic.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { openRegistryHttp } from "./registry-http.js";
import type { AssistanceCredit } from "../protocol/assistance-credit.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1 };

it("spends installation grants without acquiring VM budget authority", async () => {
  const budget = new AssistanceTraffic(6);
  const identity = { session: binding.session, generation: binding.generation, process: null };
  const issue = (producer: "installation" | "network") => [
    budget.grant({ ...identity, producer, pool: "data", bytes: 1024 * 1024, entries: 32 }),
    budget.grant({ ...identity, producer, pool: "control", bytes: 128 * 1024, entries: 32 }),
  ];
  const installation = new GrantedTraffic({ ...identity, producer: "installation" }, issue("installation"), 6);
  const network = issue("network");
  const baseline = budget.pendingBytes;
  const ports = new MessageChannel();
  const server = new RegistryChannel(ports.port1, binding, new GrantedTraffic({ ...identity, producer: "network" }, network, 6),
    { origin: "https://registry.npmjs.org", maximumBytes: 1024 }, new AbortController().signal);
  let returned: readonly AssistanceCredit[] | undefined;
  const failed = vi.fn();
  const client = new RegistryClient(registryMessagePort(ports.port2), binding, installation, network, failed, credits => { returned = credits; });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
  try {
    const response = await openRegistryHttp(client, "https://registry.npmjs.org/pkg", new AbortController().signal);
    response.acknowledgeHeaders();
    const eof = await response.read(); expect(eof.done).toBe(true); eof.acknowledge();
    await response.cancel();
  } finally { await client.close(); await server.done; }
  expect(budget.pendingBytes).toBe(baseline);
  if (returned === undefined) throw new Error("missing peer retirement receipt");
  for (const credit of [...returned, ...installation.returns()]) budget.returnCredit(credit);
  expect(budget.pendingBytes).toBe(0); expect(failed).not.toHaveBeenCalled();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(rewrite = false, delay: () => number = () => 10) {
  const budget = new AssistanceTraffic(6);
  const identity = { session: binding.session, generation: binding.generation, producer: "network" as const, process: null };
  const grants = [budget.grant({ ...identity, pool: "data", bytes: 1024 * 1024, entries: 32 }),
    budget.grant({ ...identity, pool: "control", bytes: (rewrite ? 256 : 128) * 1024, entries: 32 })];
  const ports = new MessageChannel();
  const lifetime = new AbortController();
  const server = new RegistryChannel(ports.port1, binding, new GrantedTraffic(identity, grants, 6),
    { origin: "https://registry.npmjs.org", maximumBytes: 1024 * 1024,
      ...(rewrite ? { gatewayOrigin: "http://127.0.0.1:8080" } : {}) }, lifetime.signal);
  const failed = vi.fn();
  const gateway = rewrite ? new GrantedTraffic({ ...identity, producer: "installation-gateway" }, [
    budget.grant({ ...identity, producer: "installation-gateway", pool: "data", bytes: 4 * 1024 * 1024, entries: 256 }),
    budget.grant({ ...identity, producer: "installation-gateway", pool: "control", bytes: 256 * 1024, entries: 128 }),
  ], 6) : undefined;
  const framing = gateway?.reserve("data", 3 * 1024 * 1024);
  const port = registryMessagePort(ports.port2);
  let deliveries = Promise.resolve();
  let closed = false;
  const client = new RegistryClient(rewrite ? {
    start(receive, failure) { port.start(value => {
      deliveries = deliveries.then(async () => {
        await new Promise(resolve => setTimeout(resolve, delay()));
        if (!closed) receive(value);
      });
    }, failure); },
    send: request => port.send(request),
    close() { closed = true; port.close(); },
  } : port, binding, gateway ?? registryVmBudget(budget), grants, failed,
    returned => { for (const credit of returned) budget.returnCredit(credit); });
  void server.done.catch((error: unknown) => client.fail(error));
  return { budget, server, client, failed, lifetime, ports, retireGateway() {
    if (gateway !== undefined && framing !== undefined) {
      gateway.release(framing);
      for (const credit of gateway.returns()) budget.returnCredit(credit);
    }
  } };
}

it("streams four concurrent rewritten metadata responses and retires every working window", async () => {
  let state = 1;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, random() % 12));
    // Bulk sits in a kept field: the rewriter blanks descriptive root fields.
    return new Response(JSON.stringify({ time: { note: "x".repeat(1000 + random() % 130000) },
      versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/pkg.tgz" } } } }), { headers: { "content-type": "application/json" } });
  }));
  const f = fixture(true, () => random() % 8);
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let round = 0; round < 5; round++) {
        const response = await openRegistryHttp(f.client, "https://registry.npmjs.org/pkg", new AbortController().signal);
        await new Promise(resolve => setTimeout(resolve, random() % 8));
        response.acknowledgeHeaders();
        let output = "";
        for (;;) {
          const part = await response.read(); output += new TextDecoder().decode(part.bytes);
          await new Promise(resolve => setTimeout(resolve, random() % 8));
          part.acknowledge();
          if (part.done) break;
        }
        const decoded: unknown = JSON.parse(output);
        expect(decoded).toHaveProperty(["versions", "1.0.0", "dist", "tarball"], "http://127.0.0.1:8080/pkg.tgz");
        expect(output).toMatch(/"note":"x{1000,130999}"/u);
        await response.cancel();
      }
    }));
  } finally { await f.client.close(); await f.server.done; f.retireGateway(); }
  expect(f.budget.pendingBytes).toBe(0); expect(f.failed).not.toHaveBeenCalled();
});

it("cancels HTTP acquisition while sender credit is exhausted without fencing the client", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  const full = f.budget.reserve(null, "data", 14 * 1024 * 1024);
  const baseline = f.budget.pendingBytes;
  const controller = new AbortController();
  const opening = openRegistryHttp(f.client, "https://registry.npmjs.org/example", controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = expect(Promise.race([opening, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("cancel waited for data credit")), 1000);
  })])).rejects.toMatchObject({ code: "ABORTED" });
  controller.abort();
  try {
    await cancelled;
    expect(f.budget.pendingBytes).toBe(baseline);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer);
    f.budget.release(null, full);
    await opening.catch(() => {});
    await f.client.close(); await f.server.done;
  }
  expect(f.budget.pendingBytes).toBe(0);
  expect(f.failed).not.toHaveBeenCalled();
});

it("accounts for sender copies until exact delivery acknowledgement and retirement", async () => {
  let sent = false;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    type: "bytes", pull(stream) {
      if (!sent) { sent = true; stream.enqueue(new Uint8Array([1, 2, 3])); }
      else { stream.close(); stream.byobRequest?.respond(0); }
    },
  }))));
  const f = fixture();
  const baseline = f.budget.pendingBytes;
  const opening = f.client.start("https://registry.npmjs.org/example");
  expect(f.budget.pendingBytes).toBeGreaterThan(baseline);
  const request = await opening.identity;
  const head = await opening.response;
  expect(head.value.status).toBe(200);
  const held = f.budget.pendingBytes;
  expect(() => f.client.read(request)).toThrow("acknowledgement");
  head.acknowledge();
  expect(f.budget.pendingBytes).toBeLessThan(held);
  expect(() => head.acknowledge()).toThrow("acknowledgement");
  const body = await f.client.read(request);
  expect([...body.value.bytes]).toEqual([1, 2, 3]);
  body.acknowledge();
  const eof = await f.client.read(request);
  expect(eof.value.done).toBe(true);
  eof.acknowledge();
  expect(f.budget.pendingBytes).toBe(baseline);
  await f.client.cancel(request);
  await f.client.close(); await f.server.done;
  expect(f.budget.pendingBytes).toBe(0);
  expect(f.failed).not.toHaveBeenCalled();
});

it.each([false, true])("waits for VM credit before registry dispatch; retirement=%s", async retire => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  const full = f.budget.reserve(null, "data", 14 * 1024 * 1024);
  try {
    const opening = f.client.start("https://registry.npmjs.org/example");
    const response = retire ? expect(opening.response).rejects.toMatchObject({ code: "ABORTED" }) : opening.response;
    const identity = retire ? expect(opening.identity).rejects.toMatchObject({ code: "ABORTED" }) : opening.identity;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetcher).not.toHaveBeenCalled();
    if (retire) {
      await f.client.close();
      await response; await identity;
      expect(f.budget.pendingBytes).toBe(14 * 1024 * 1024);
      f.budget.release(null, full);
    } else {
      f.budget.release(null, full);
      const head = await opening.response;
      expect(fetcher).toHaveBeenCalledOnce();
      head.acknowledge();
      await f.client.cancel(await opening.identity);
    }
  } finally {
    await f.client.close(); await f.server.done;
  }
  expect(f.budget.pendingBytes).toBe(0);
  expect(f.failed).not.toHaveBeenCalled();
});

it("does not spend a reply deadline waiting for local credit", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  const full = f.budget.reserve(null, "data", 14 * 1024 * 1024);
  const opening = f.client.start("https://registry.npmjs.org/example");
  void opening.response.catch(() => {});
  try {
    await vi.advanceTimersByTimeAsync(60_001);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
    vi.useRealTimers();
    f.budget.release(null, full);
    (await opening.response).acknowledge();
    await f.client.cancel(await opening.identity);
  } finally {
    vi.useRealTimers();
    if (f.failed.mock.calls.length !== 0) f.lifetime.abort();
    await Promise.allSettled([f.client.close(), f.server.done]);
  }
  expect(f.budget.pendingBytes).toBe(0);
});

it("leaves network deadlines with the peer while another response holds its credit", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  const first = await f.client.start("https://registry.npmjs.org/first").response;
  const second = f.client.start("https://registry.npmjs.org/second");
  void second.response.catch(() => {});
  await second.identity;
  try {
    await vi.advanceTimersByTimeAsync(60_001);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.failed).not.toHaveBeenCalled();
    first.acknowledge();
    (await second.response).acknowledge();
  } finally {
    vi.useRealTimers();
    if (f.failed.mock.calls.length !== 0) f.lifetime.abort();
    await Promise.allSettled([f.client.close(), f.server.done]);
  }
  expect(f.budget.pendingBytes).toBe(0);
});

it("cancels an opening request using its early identity", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  })));
  const f = fixture();
  const opening = f.client.start("https://registry.npmjs.org/example");
  const outcome = expect(opening.response).rejects.toMatchObject({ code: "ABORTED" });
  await f.client.cancel(await opening.identity);
  await outcome;
  await f.client.close(); await f.server.done;
  expect(f.budget.pendingBytes).toBe(0);
});

it.each(["acknowledge", "cancel", "retire"])("waits for peer header credit and completes %s while blocked", async action => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(null)));
  vi.stubGlobal("fetch", fetcher);
  const f = fixture();
  try {
    const first = f.client.start("https://registry.npmjs.org/first");
    const head = await first.response;
    const second = f.client.start("https://registry.npmjs.org/second");
    const secondId = await second.identity;
    expect(fetcher).toHaveBeenCalledOnce();
    if (action === "acknowledge") {
      head.acknowledge();
      const next = await second.response;
      expect(fetcher).toHaveBeenCalledTimes(2);
      next.acknowledge();
      await f.client.cancel(secondId);
    } else {
      const cancelled = expect(second.response).rejects.toMatchObject({ code: "ABORTED" });
      if (action === "retire") await f.client.close();
      else { await f.client.cancel(secondId); head.acknowledge(); }
      await cancelled;
      expect(fetcher).toHaveBeenCalledOnce();
    }
    if (action !== "retire") await f.client.cancel(await first.identity);
  } finally { await f.client.close(); await f.server.done; }
  expect(f.budget.pendingBytes).toBe(0);
  expect(f.failed).not.toHaveBeenCalled();
});

it("cancels a credit-blocked read without dispatching it after cancellation", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
  const f = fixture();
  const opening = f.client.start("https://registry.npmjs.org/example");
  const request = await opening.identity;
  (await opening.response).acknowledge();
  const full = f.budget.reserve(null, "data", 14 * 1024 * 1024);
  const reading = f.client.read(request);
  const outcome = expect(reading).rejects.toMatchObject({ code: "ABORTED" });
  try {
    await f.client.cancel(request);
    await outcome;
    f.budget.release(null, full);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.client.close(); await f.server.done; }
  expect(f.budget.pendingBytes).toBe(0);
});

it("retirement fences held replies and shares one cleanup outcome", async () => {
  const f = fixture();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
  const head = await f.client.start("https://registry.npmjs.org/example").response;
  const closing = f.client.close();
  expect(f.client.close()).toBe(closing);
  await closing; await f.server.done;
  expect(() => head.acknowledge()).toThrow();
  expect(f.budget.pendingBytes).toBe(0);
});

it("fences malformed retirement without releasing any grant", async () => {
  const f = fixture();
  f.ports.port1.onmessage = () => f.ports.port1.postMessage({ version: REGISTRY_PROTOCOL_VERSION, ...binding, sequence: 1,
    correlation: 1, kind: "retired", credits: [] });
  await expect(f.client.close()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(f.failed).toHaveBeenCalledOnce();
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  f.lifetime.abort(); await expect(f.server.done).rejects.toBeDefined();
});

it("cancellation and retirement progress with the VM data pool saturated", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
  const f = fixture();
  const opening = f.client.start("https://registry.npmjs.org/example");
  const request = await opening.identity;
  const head = await opening.response;
  const remaining = 15 * 1024 * 1024 - 1024 * 1024 - 512 * 1024;
  const full = f.budget.reserve(null, "data", remaining);
  await f.client.cancel(request);
  head.acknowledge();
  await f.client.close(); await f.server.done;
  expect(f.budget.pendingBytes).toBe(remaining);
  f.budget.release(null, full);
  expect(f.budget.pendingBytes).toBe(0);
});

it("retains sender reservations when a command cannot transfer", async () => {
  const f = fixture();
  vi.spyOn(f.ports.port2, "postMessage").mockImplementation(() => { throw new Error("lost port"); });
  const opening = f.client.start("https://registry.npmjs.org/example");
  await expect(opening.identity).rejects.toBeDefined();
  await expect(opening.response).rejects.toBeDefined();
  await expect(f.client.close()).rejects.toBeDefined();
  expect(f.budget.pendingBytes).toBeGreaterThan(0);
  expect(f.failed).toHaveBeenCalledOnce();
  f.lifetime.abort(); await expect(f.server.done).rejects.toBeDefined();
});

it("fences failed cleanup reported during acquisition without returning reservations", async () => {
  const f = fixture();
  f.ports.port1.onmessage = () => f.ports.port1.postMessage({ version: REGISTRY_PROTOCOL_VERSION, ...binding, sequence: 1,
    correlation: 1, kind: "failure", reservation: 7,
    error: { code: "RELAY_ERROR", message: "cleanup failed", detail: { cleanupFailed: true } },
  });
  const opening = f.client.start("https://registry.npmjs.org/example");
  try {
    await expect(opening.response).rejects.toMatchObject({ code: "RELAY_ERROR" });
    await expect(opening.identity).rejects.toMatchObject({ code: "RELAY_ERROR" });
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.budget.pendingBytes).toBeGreaterThan(0);
  } finally {
    f.client.fail(new Error("test cleanup"));
    f.lifetime.abort(); await expect(f.server.done).rejects.toBeDefined();
  }
});
