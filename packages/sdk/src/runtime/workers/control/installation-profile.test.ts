import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { InstallationProfileRecorder } from "./installation-profile.js";
import { decodeInstallationProfile } from "../../protocol/assistance-installation-profile.js";
import type { RegistryReply, RegistryRequest } from "../../protocol/registry.js";

const binding = { version: 32 as const, session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 3 };
type RequestOperation = RegistryRequest extends infer R ? R extends { kind: string } ? Omit<R, keyof typeof binding | "sequence"> : never : never;
type ReplyOperation = RegistryReply extends infer R ? R extends { kind: string } ? Omit<R, keyof typeof binding | "sequence" | "correlation"> : never : never;
function request(sequence: number, operation: RequestOperation): RegistryRequest {
  return { ...binding, sequence, ...operation };
}
function reply(sequence: number, correlation: number, operation: ReplyOperation): RegistryReply {
  return { ...binding, sequence, correlation, ...operation };
}

it("records phase boundaries, exchange round trips and registry request timelines from an injected clock", () => {
  let now = 100;
  const recorder = new InstallationProfileRecorder(3, () => now);
  recorder.begin("connect"); now = 150; recorder.end("connect");
  recorder.begin("install");
  recorder.exchange({ kind: "write", bytes: 4096, requestMs: 12.5, acknowledgeMs: 3, failed: null });
  recorder.exchange({ kind: "write", bytes: 4096, requestMs: 7.5, acknowledgeMs: 5, failed: null });
  recorder.exchange({ kind: "read", bytes: 64, requestMs: 1, acknowledgeMs: 1, failed: null });
  now = 200; recorder.registryRequest(request(1, { kind: "start", url: "https://registry.npmjs.org/react" }));
  now = 210; recorder.registryReply(reply(1, 1, { kind: "started", request: 1, reservation: 1 }));
  now = 240; recorder.registryReply(reply(2, 1, { kind: "headers", request: 1, reservation: 2, status: 200, headers: [] }));
  now = 250; recorder.registryRequest(request(2, { kind: "read", request: 1 }));
  now = 280; recorder.registryReply(reply(3, 2, { kind: "data", request: 1, reservation: 3, bytes: new Uint8Array(new ArrayBuffer(3)), done: false }));
  now = 300; recorder.registryRequest(request(3, { kind: "acknowledge", request: 1, reservation: 3 }));
  now = 310; recorder.registryRequest(request(4, { kind: "read", request: 1 }));
  now = 320; recorder.registryReply(reply(4, 4, { kind: "data", request: 1, reservation: 4, bytes: new Uint8Array(new ArrayBuffer(0)), done: true }));
  now = 400;
  const snapshot = recorder.snapshot();
  expect(snapshot).toEqual({
    installation: 3,
    phases: [{ name: "connect", startedMs: 100, endedMs: 150 }, { name: "install", startedMs: 150, endedMs: null }],
    exchanges: [
      { kind: "write", count: 2, bytes: 8192, requestMs: 20, maxRequestMs: 12.5, acknowledgeMs: 8, maxAcknowledgeMs: 5, failures: 0, lastFailure: null },
      { kind: "read", count: 1, bytes: 64, requestMs: 1, maxRequestMs: 1, acknowledgeMs: 1, maxAcknowledgeMs: 1, failures: 0, lastFailure: null },
    ],
    registry: {
      requests: [{ request: 1, startedMs: 200, headersMs: 240, reads: 2, bytes: 3, networkWaitMs: 40, maxNetworkWaitMs: 30, gapMs: 30, maxGapMs: 30, done: true }],
      dropped: 0,
      network: null,
    },
    gateway: null,
  });
  expect(decodeInstallationProfile(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
});

it("keeps the gateway's lockfile outcome and decodes only its closed shapes", () => {
  const recorder = new InstallationProfileRecorder(4, () => 0);
  recorder.gateway({ kind: "verbatim", reason: "unreadable", detail: "missing /workspace/pnpm-lock.yaml" });
  expect(recorder.snapshot().gateway).toEqual({ kind: "verbatim", reason: "unreadable", detail: "missing /workspace/pnpm-lock.yaml" });
  recorder.gateway({ kind: "frozen", path: "/workspace/app/pnpm-lock.yaml", packages: 58 });
  const snapshot = recorder.snapshot();
  expect(snapshot.gateway).toEqual({ kind: "frozen", path: "/workspace/app/pnpm-lock.yaml", packages: 58 });
  expect(decodeInstallationProfile(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  const base = snapshot;
  expect(() => decodeInstallationProfile({ ...base, gateway: { kind: "verbatim", reason: "because", detail: null } })).toThrow();
  expect(decodeInstallationProfile({ ...base, gateway: { kind: "verbatim", reason: "outside-workspace", detail: null } }).gateway)
    .toEqual({ kind: "verbatim", reason: "outside-workspace", detail: null });
  expect(() => decodeInstallationProfile({ ...base, gateway: { kind: "frozen", path: "/workspace/pnpm-lock.yaml" } })).toThrow();
  expect(() => decodeInstallationProfile({ ...base, gateway: { kind: "frozen", path: "", packages: 1 } })).toThrow();
  expect(() => decodeInstallationProfile({ ...base, gateway: { kind: "verbatim", reason: "unreadable", detail: "x".repeat(257) } })).toThrow();
});

it("bounds the registry timeline and counts what it drops", () => {
  const recorder = new InstallationProfileRecorder(1, () => 0);
  for (let id = 1; id <= 514; id++) recorder.registryRequest(request(id, { kind: "start", url: `https://registry.npmjs.org/p${id}` }));
  const snapshot = recorder.snapshot();
  expect(snapshot.registry.requests).toHaveLength(512);
  expect(snapshot.registry.dropped).toBe(2);
  recorder.registryReply(reply(600, 514, { kind: "headers", request: 514, reservation: 1, status: 200, headers: [] }));
  expect(recorder.snapshot().registry.dropped).toBe(2);
});

function rejection(decode: () => unknown): string {
  try { decode(); } catch (error) { return error instanceof VMError ? error.code : "unexpected"; }
  return "accepted";
}

it("rejects profiles with unknown fields, unknown phases or negative counters", () => {
  const valid = new InstallationProfileRecorder(1, () => 0).snapshot();
  expect(decodeInstallationProfile(valid)).toEqual(valid);
  expect(rejection(() => decodeInstallationProfile({ ...valid, extra: true }))).toBe("PROTOCOL_ERROR");
  expect(rejection(() => decodeInstallationProfile({ ...valid, phases: [{ name: "compile", startedMs: 0, endedMs: null }] }))).toBe("PROTOCOL_ERROR");
  expect(rejection(() => decodeInstallationProfile({ ...valid, exchanges: [{ kind: "write", count: -1, bytes: 0, requestMs: 0, maxRequestMs: 0, acknowledgeMs: 0, maxAcknowledgeMs: 0 }] }))).toBe("PROTOCOL_ERROR");
  expect(rejection(() => decodeInstallationProfile({ ...valid, registry: { ...valid.registry, network: { creditWaitMs: 1, upstreamMs: 1, requests: 1, bytes: Number.NaN } } }))).toBe("PROTOCOL_ERROR");
});

it("decodes the connect sub-phases that split the gateway start", () => {
  const recorder = new InstallationProfileRecorder(1, () => 0);
  for (const name of ["connect:credits", "connect:registry", "connect:streams", "connect:start"] as const) {
    recorder.begin(name);
    recorder.end(name);
  }
  const decoded = decodeInstallationProfile(JSON.parse(JSON.stringify(recorder.snapshot())));
  expect(decoded.phases.map(phase => phase.name)).toEqual(["connect:credits", "connect:registry", "connect:streams", "connect:start"]);
});

it("counts a failed exchange under its kind and names the step that failed", () => {
  const recorder = new InstallationProfileRecorder(5, () => 0);
  recorder.exchange({ kind: "activate-materialized", bytes: 0, requestMs: 420, acknowledgeMs: 12, failed: "acknowledge" });
  recorder.exchange({ kind: "read", bytes: 0, requestMs: 3, acknowledgeMs: 0, failed: "request" });
  recorder.exchange({ kind: "read", bytes: 8, requestMs: 2, acknowledgeMs: 1, failed: null });
  const snapshot = recorder.snapshot();
  expect(snapshot.exchanges).toEqual([
    { kind: "activate-materialized", count: 1, bytes: 0, requestMs: 420, maxRequestMs: 420, acknowledgeMs: 12, maxAcknowledgeMs: 12, failures: 1, lastFailure: "acknowledge" },
    { kind: "read", count: 2, bytes: 8, requestMs: 5, maxRequestMs: 3, acknowledgeMs: 1, maxAcknowledgeMs: 1, failures: 1, lastFailure: "request" },
  ]);
  expect(decodeInstallationProfile(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  const [first] = snapshot.exchanges;
  expect(() => decodeInstallationProfile({ ...snapshot, exchanges: [{ ...first, lastFailure: "later" }] })).toThrow();
  expect(() => decodeInstallationProfile({ ...snapshot, exchanges: [{ ...first, failures: -1 }] })).toThrow();
  expect(() => decodeInstallationProfile({ ...snapshot, exchanges: [{ ...first, failures: 2 }] })).toThrow();
});
