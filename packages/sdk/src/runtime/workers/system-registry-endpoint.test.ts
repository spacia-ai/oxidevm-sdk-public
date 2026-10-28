import { expect, it, vi } from "vitest";
import { REGISTRY_PROTOCOL_VERSION } from "../protocol/registry.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { InstallationProfileRecorder } from "./control/installation-profile.js";
import { SystemNetworkChannel, SystemNetworkClient } from "./system-network-channel.js";
import { RegistryClient } from "./registry-client.js";
import { registryBytePipe } from "./registry-pipe.js";
import { GrantedTraffic } from "./assistance/traffic.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };

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

it("records the guest gateway's request timeline from the forwarded registry traffic", async () => {
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
  let clock = 1000;
  const recorder = new InstallationProfileRecorder(1, () => clock);
  endpoint.forward(requests.readable, replies.writable, recorder);
  const pipe = registryBytePipe(replies.readable, requests.writable, gateway);
  const guest = new RegistryClient(pipe, { ...binding, installation: 1 }, gateway, endpoint.credits, failed, () => {});
  const head = await guest.start("https://registry.npmjs.org/example").response;
  head.acknowledge();
  clock = 1200;
  const data = await guest.read(head.value.request);
  expect(data.value.bytes).toEqual(new Uint8Array([3, 1, 4]));
  data.acknowledge();
  await guest.close(); await pipe.done;
  await endpoint.close();
  for (const credit of gateway.returns()) traffic.returnCredit(credit);
  await client.close();
  const snapshot = recorder.snapshot();
  expect(snapshot.registry.dropped).toBe(0);
  expect(snapshot.registry.requests).toHaveLength(1);
  expect(snapshot.registry.requests[0]).toMatchObject({ request: 1, startedMs: 1000, headersMs: 1000, reads: 1, bytes: 3, done: false });
  expect(snapshot.registry.network).toMatchObject({ requests: 1, bytes: 3 });
  expect(Number.isFinite(snapshot.registry.network?.creditWaitMs)).toBe(true);
  expect(Number.isFinite(snapshot.registry.network?.upstreamMs)).toBe(true);
  expect(failed).not.toHaveBeenCalled();
  expect(traffic.pendingBytes).toBe(0);
  expect(REGISTRY_PROTOCOL_VERSION).toBe(32);
  server.close(); pair.port1.close(); pair.port2.close(); vi.unstubAllGlobals();
});
