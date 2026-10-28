import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeAssistanceRequest, encodeAssistanceRequest, isAssistanceSupervisoryOperation } from "./assistance.js";
import { decodeAssistanceReply, encodeAssistanceReply, matchAssistanceReply } from "./assistance-reply.js";
import { decodeBrokerCommand, decodeBrokerEvent } from "./assistance-broker.js";

function fixture(file: string): Uint8Array<ArrayBuffer>[] {
  return readFileSync(new URL(`../../../../../tests/fixtures/assistance/${file}`, import.meta.url), "utf8").trim().split("\n").map(line => {
    const hex = line.split(" ")[1];
    if (hex === undefined) throw new Error("fixture");
    return new Uint8Array(Buffer.from(hex, "hex"));
  });
}

it("shares watch request bytes with Rust through the validated broker boundary", () => {
  for (const bytes of fixture("task-watch-v7.hex")) {
    const request = decodeAssistanceRequest(bytes);
    expect(encodeAssistanceRequest(request)).toEqual(bytes);
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceRequest(bytes.slice(0, end))).toThrow();
    const { operation, ...identity } = request;
    expect(isAssistanceSupervisoryOperation(operation)).toBe(operation.kind === "watch-remove");
    expect(decodeBrokerEvent({ kind: "request", identity, operation })).toEqual({ kind: "request", identity, operation });
  }
});

it("retains watch reply identity through the broker and rejects legacy codecs", () => {
  for (const bytes of fixture("task-watch-reply-v7.hex")) {
    const reply = decodeAssistanceReply(bytes, 7);
    expect(encodeAssistanceReply(reply, 7)).toEqual(bytes);
    const identity = { session: reply.session, generation: reply.generation, process: reply.process, sequence: reply.sequence };
    expect(decodeBrokerCommand({ kind: "reply", identity, bytes })).toEqual({ kind: "reply", identity, bytes });
    for (const version of [4, 5, 6]) {
      expect(() => decodeAssistanceReply(bytes, version)).toThrow();
      expect(() => encodeAssistanceReply(reply, version)).toThrow();
    }
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceReply(bytes.slice(0, end), 7)).toThrow();
    if (reply.result.kind === "watch-opened") {
      expect(matchAssistanceReply({ ...identity, operation: { kind: "watch-add", path: "/workspace" } }, reply)).toEqual(reply.result);
    } else {
      expect(matchAssistanceReply({ ...identity, operation: { kind: "watch-read" } }, reply)).toEqual(reply.result);
    }
  }
});


it("rejects forged watcher identities, masks, sequences and unbounded batches", () => {
  const reply = decodeAssistanceReply(fixture("task-watch-reply-v7.hex")[1] ?? new Uint8Array(), 7);
  if (reply.result.kind !== "watch-events") throw new Error("events");
  const first = reply.result.events[0]; if (first === undefined) throw new Error("first");
  for (const event of [
    { ...first, sequence: 0n }, { ...first, watch: null }, { ...first, watch: 0 },
    { ...first, mask: 0 }, { ...first, mask: 0x80000000 }, { ...first, change: "rename" },
    { ...first, cookie: 1 }, { ...first, name: new Uint8Array([0]) },
    { ...first, name: new Uint8Array([47]) }, { ...first, name: new Uint8Array(256).fill(65) },
  ]) expect(() => encodeAssistanceReply({ ...reply, result: { kind: "watch-events", events: [event] } }, 7)).toThrow();
  for (const events of [[first, first], Array.from({ length: 257 }, (_, i) => ({ ...first, sequence: BigInt(i + 1) })),
    Array.from({ length: 100 }, (_, i) => ({ ...first, sequence: BigInt(i + 1), name: new Uint8Array(255).fill(65) }))]) {
    expect(() => encodeAssistanceReply({ ...reply, result: { kind: "watch-events", events } }, 7)).toThrow();
  }
});
