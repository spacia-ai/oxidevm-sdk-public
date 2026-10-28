import { expect, it } from "vitest";
import { decodeAssistanceBootstrap, decodeAssistanceBootstrapResult } from "./assistance-bootstrap.js";

it("validates the one-use bootstrap binding, port and pinned artifact manifest", () => {
  const channel = new MessageChannel();
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const artifacts = { version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } }, compiler: { bytes: 8, sha256: "a".repeat(64) }, runtime: { bytes: 10, sha256: "b".repeat(64) } };
  const input = { kind: "assistance-bootstrap", binding, nonce: binding.session, artifacts, port: channel.port1 };
  try {
    expect(decodeAssistanceBootstrap(input)).toEqual(input);
    expect(() => decodeAssistanceBootstrap({ ...input, port: {} })).toThrow();
    expect(() => decodeAssistanceBootstrap({ ...input, nonce: "reusable" })).toThrow();
    expect(() => decodeAssistanceBootstrap({ ...input, source: "untrusted" })).toThrow();
    const ready = { kind: "broker-ready", binding, nonce: binding.session };
    expect(decodeAssistanceBootstrapResult(ready)).toEqual(ready);
    expect(() => decodeAssistanceBootstrapResult({ ...ready, port: channel.port2 })).toThrow();
  } finally { channel.port1.close(); channel.port2.close(); }
});

it("binds runtime bootstrap grants to the pinned artifact and returns only staging credit", () => {
  const channel = new MessageChannel();
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const artifacts = { version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } }, compiler: { bytes: 8, sha256: "a".repeat(64) }, runtime: { bytes: 10, sha256: "b".repeat(64) } };
  const credits = [10, 4116].map((bytes, index) => ({ ...binding, kind: "grant", producer: "bootstrap", pool: "data", process: null,
    bytes, entries: index === 0 ? 1 : 32, sequence: index + 1, reservation: index + 1 }));
  const input = { kind: "assistance-bootstrap", binding, nonce: binding.session, artifacts, credits, port: channel.port1 };
  try {
    expect(decodeAssistanceBootstrap(input)).toEqual(input);
    for (const invalid of [[], [credits[0]], [credits[0], credits[0]], credits.map(credit => ({ ...credit, generation: 2 })),
      credits.map(credit => ({ ...credit, bytes: 1 }))]) expect(() => decodeAssistanceBootstrap({ ...input, credits: invalid })).toThrow();
    const receipt = { ...credits[1], kind: "return" };
    const ready = { kind: "broker-ready", binding, nonce: binding.session, receipt };
    expect(decodeAssistanceBootstrapResult(ready)).toEqual(ready);
    expect(() => decodeAssistanceBootstrapResult({ ...ready, receipt: { ...receipt, producer: "guest", process: 1 } })).toThrow();
  } finally { channel.port1.close(); channel.port2.close(); }
});
