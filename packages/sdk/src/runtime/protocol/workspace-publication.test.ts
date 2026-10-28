import { expect, it } from "vitest";
import { decodeStorageIncoming, PROTOCOL_VERSION } from "../protocol.js";
import { AssistanceTraffic } from "../workers/control/assistance-traffic.js";

it("decodes credited workspace publication and rejects reused or mismatched transfers", () => {
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const traffic = new AssistanceTraffic(6);
  const credit = traffic.grant({ ...binding, producer: "storage", process: null, pool: "data", bytes: 8 * 1024 * 1024, entries: 1 });
  const first = new MessageChannel();
  const second = new MessageChannel();
  const channels = [first, second];
  const descriptor = (transfer: number, retirementPort: MessagePort) => ({
    version: PROTOCOL_VERSION, binding, transfer, bytes: 0, stream: new ReadableStream<unknown>(), retirementPort,
  });
  const snapshot = descriptor(1, first.port1);
  const delta = descriptor(2, second.port1);
  const message = { id: 1, version: PROTOCOL_VERSION, type: "commit-workspace-streams", publication: {
    workspaceBaseSha256: "a".repeat(64), credit, snapshot, delta,
  } };
  try {
    expect(decodeStorageIncoming(message)).toEqual(message);
    for (const change of [
      { delta: snapshot },
      { delta: { ...delta, transfer: 1 } },
      { delta: { ...delta, binding: { ...binding, generation: 2 } } },
      { credit: { ...credit, bytes: 1 } },
      { unexpected: true },
    ]) expect(() => decodeStorageIncoming({ ...message, publication: { ...message.publication, ...change } })).toThrow();
  } finally { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } }
});
