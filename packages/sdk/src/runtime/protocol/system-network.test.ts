import { PROTOCOL_VERSION } from "./common.js";
import { expect, it } from "vitest";
import { decodeRegistryFetchPolicy, decodeSystemNetworkMessage } from "./system-network.js";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
const grant = { ...binding, kind: "grant", producer: "network", process: null, pool: "control", bytes: 4096, entries: 4, sequence: 1, reservation: 1 };
const credits = [grant, { ...grant, pool: "data", sequence: 2, reservation: 2 }];
const message = { version: PROTOCOL_VERSION, ...binding, sequence: 1, kind: "bind", credits };

it("admits only an exact installation-loopback origin for metadata rewriting", () => {
  const policy = { origin: "https://registry.npmjs.org", maximumBytes: 1024 };
  expect(decodeRegistryFetchPolicy({ ...policy, gatewayOrigin: "http://127.0.0.1:8080" })).toEqual({ ...policy, gatewayOrigin: "http://127.0.0.1:8080" });
  for (const gatewayOrigin of [undefined, "http://external.test", "http://user@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1#fragment", "https://127.0.0.1", "http://127.0.0.1?query"]) {
    expect(() => decodeRegistryFetchPolicy({ ...policy, gatewayOrigin })).toThrow();
  }
});

it("decodes exact network grants and their retirement receipts", () => {
  const preview = new MessageChannel().port1;
  expect(decodeSystemNetworkMessage({ ...message, preview })).toEqual({ ...message, preview });
  preview.close();
  const retired = { ...message, kind: "retired", sequence: 2, credits: credits.map(credit => ({ ...credit, kind: "return" })) };
  expect(decodeSystemNetworkMessage(retired)).toEqual(retired);
});

it.each([
  { process: 1 }, { producer: "bootstrap" }, { generation: 2 }, { kind: "return" },
  { pool: "control" }, { reservation: 1 }, { sequence: 1 }, { bytes: 0 }, { entries: 0 },
])("rejects a mismatched or duplicated network grant %j", patch => {
  expect(() => decodeSystemNetworkMessage({ ...message, preview: new MessageChannel().port1, credits: [grant, { ...credits[1], ...patch }] })).toThrow();
});

it.each([{ version: 30 }, { sequence: 0 }, { sequence: 0x1_0000_0000 }, { installation: 1 }, { kind: "fetch" }])(
  "rejects malformed network envelopes %j", patch => {
    expect(() => decodeSystemNetworkMessage({ ...message, ...patch })).toThrow();
  },
);

it("validates installation ports and registry authority without accepting extra policy", () => {
  const ports = new MessageChannel();
  const policy = { origin: "https://registry.npmjs.org", maximumBytes: 1024 };
  const registry = { ...message, kind: "registry", installation: 1, port: ports.port1, policy };
  try {
    expect(decodeSystemNetworkMessage(registry)).toEqual(registry);
    for (const patch of [{ installation: 0 }, { installation: 0x1_0000_0000 }, { port: {} }, { unexpected: true }]) {
      expect(() => decodeSystemNetworkMessage({ ...registry, ...patch })).toThrow();
    }
    for (const patch of [
      { origin: "http://registry.npmjs.org" }, { origin: "https://user:secret@registry.npmjs.org" },
      { origin: "https://registry.npmjs.org/path" }, { origin: "https://registry.npmjs.org#fragment" },
      { origin: "x".repeat(513) }, { maximumBytes: -1 }, { maximumBytes: Number.MAX_SAFE_INTEGER + 1 },
      { headers: { authorization: "secret" } },
    ]) expect(() => decodeSystemNetworkMessage({ ...registry, policy: { ...policy, ...patch } })).toThrow();
  } finally { ports.port1.close(); ports.port2.close(); }
});

it("decodes supervised installation retirement with exact grants and identities", () => {
  const retire = { version: PROTOCOL_VERSION, ...binding, sequence: 3, kind: "registry-retire", installation: 7 };
  const retired = { ...retire, kind: "registry-retired", credits: credits.map(credit => ({ ...credit, kind: "return" })) };
  expect(decodeSystemNetworkMessage(retire)).toEqual(retire);
  expect(decodeSystemNetworkMessage(retired)).toEqual(retired);
  for (const patch of [{ installation: 0 }, { installation: 0x1_0000_0000 }, { extra: true }, { sequence: 0 }, { version: 30 }]) {
    expect(() => decodeSystemNetworkMessage({ ...retire, ...patch })).toThrow();
    expect(() => decodeSystemNetworkMessage({ ...retired, ...patch })).toThrow();
  }
  expect(() => decodeSystemNetworkMessage({ ...retire, credits: [] })).toThrow();
  expect(() => decodeSystemNetworkMessage({ ...retired, credits })).toThrow();
});

it("binds the control-owned preview runtime port with the generation and nowhere else", () => {
  const preview = new MessageChannel().port1;
  const bound = { ...message, preview };
  expect(decodeSystemNetworkMessage(bound)).toEqual(bound);
  expect(() => decodeSystemNetworkMessage(message)).toThrow();
  expect(() => decodeSystemNetworkMessage({ ...bound, preview: {} })).toThrow();
  expect(() => decodeSystemNetworkMessage({ ...message, kind: "retired", sequence: 2, preview, credits: credits.map(credit => ({ ...credit, kind: "return" })) })).toThrow();
  expect(() => decodeSystemNetworkMessage({ ...message, kind: "ping", sequence: 2, preview, credits: undefined })).toThrow();
  preview.close();
});

it("carries a frozen version set in the gateway policy and bounds it, never in the public fetch policy", () => {
  const ports = new MessageChannel();
  const policy = { origin: "https://registry.npmjs.org", maximumBytes: 1024, frozenVersions: { next: ["16.2.12"], "@img/colour": ["1.1.0", "1.0.0"] } };
  const registry = { ...message, kind: "registry-attach", installation: 2, port: ports.port1, policy };
  try {
    expect(decodeSystemNetworkMessage(registry)).toEqual(registry);
    expect(() => decodeRegistryFetchPolicy(policy)).toThrow();
    for (const frozenVersions of [
      [], "next", { next: "16.2.12" }, { next: [] }, { next: [1] }, { next: ["16.2.12", ""] }, { next: ["file:../probe"] },
      { "": ["1.0.0"] }, { ["x".repeat(215)]: ["1.0.0"] }, { next: ["v".repeat(257)] }, { next: Array.from({ length: 65 }, (_, i) => `1.0.${i}`) },
      { "../escape": ["1.0.0"] }, { "next\n": ["1.0.0"] },
    ]) expect(() => decodeSystemNetworkMessage({ ...registry, policy: { ...policy, frozenVersions } })).toThrow();
  } finally { ports.port1.close(); ports.port2.close(); }
});
