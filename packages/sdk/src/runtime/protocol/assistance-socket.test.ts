import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeAssistanceRequest, encodeAssistanceRequest, decodeAssistanceSocketAddress, isAssistanceSupervisoryOperation } from "./assistance.js";
import { decodeAssistanceReply, encodeAssistanceReply, matchAssistanceReply } from "./assistance-reply.js";
import { decodeBrokerCommand, decodeBrokerEvent } from "./assistance-broker.js";

function fixture(file: string): Uint8Array<ArrayBuffer>[] {
  return readFileSync(new URL(`../../../../../tests/fixtures/assistance/${file}`, import.meta.url), "utf8").trim().split("\n").map(line => {
    const hex = line.split(" ")[1];
    if (hex === undefined) throw new Error("fixture");
    return new Uint8Array(Buffer.from(hex, "hex"));
  });
}

it("shares socket request bytes with Rust through the validated broker boundary", () => {
  for (const bytes of fixture("task-socket-v7.hex")) {
    const request = decodeAssistanceRequest(bytes);
    expect(encodeAssistanceRequest(request)).toEqual(bytes);
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceRequest(bytes.slice(0, end))).toThrow();
    const { operation, ...identity } = request;
    expect(isAssistanceSupervisoryOperation(operation)).toBe(operation.kind === "socket-shutdown" || operation.kind === "socket-close");
    expect(decodeBrokerEvent({ kind: "request", identity, operation })).toEqual({ kind: "request", identity, operation });
  }
});

it("retains socket reply identity through the broker and rejects legacy codecs", () => {
  for (const bytes of fixture("task-socket-reply-v7.hex")) {
    const reply = decodeAssistanceReply(bytes, 7);
    expect(encodeAssistanceReply(reply, 7)).toEqual(bytes);
    const identity = { session: reply.session, generation: reply.generation, process: reply.process, sequence: reply.sequence };
    expect(decodeBrokerCommand({ kind: "reply", identity, bytes })).toEqual({ kind: "reply", identity, bytes });
    for (const version of [4, 5, 6]) {
      expect(() => decodeAssistanceReply(bytes, version)).toThrow();
      expect(() => encodeAssistanceReply(reply, version)).toThrow();
    }
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceReply(bytes.slice(0, end), 7)).toThrow();
    if (reply.result.kind !== "socket") throw new Error("socket required");
    const socket = reply.result;
    expect(matchAssistanceReply({ ...identity, operation: { kind: "socket-address", fd: socket.fd } }, reply)).toEqual(socket);
    expect(() => matchAssistanceReply({ ...identity, operation: { kind: "socket-address", fd: socket.fd + 1 } }, reply)).toThrow();
  }
});

it("rejects invalid IPs, ports and socket control values before transport", () => {
  for (const address of ["localhost", "127.0.0.01", "256.0.0.1", "127.0.0.1\n", ":::", "[::1]", "::1%lo", "", "0x7f000001"]) {
    expect(() => decodeAssistanceSocketAddress({ address, port: 3000 })).toThrow();
  }
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "2001:db8::1234"]) {
    expect(decodeAssistanceSocketAddress({ address, port: 3000 })).toEqual({ address, port: 3000 });
  }
  for (const port of [0, -1, 65536, 3.5]) expect(() => decodeAssistanceSocketAddress({ address: "::1", port })).toThrow();
  const bytes = fixture("task-socket-v7.hex").at(-2);
  if (bytes === undefined) throw new Error("fixture");
  const bad = bytes.slice(); bad[bad.length - 1] = 2;
  expect(() => decodeAssistanceRequest(bad)).toThrow();
});


it("rejects malformed keepalive booleans and delays", () => {
  const bytes = fixture("task-socket-v7.hex").at(-1);
  if (bytes === undefined) throw new Error("fixture");
  const bad = bytes.slice(); bad[bad.length - 5] = 2;
  expect(() => decodeAssistanceRequest(bad)).toThrow();
  const { operation, ...identity } = decodeAssistanceRequest(bytes);
  expect(operation.kind).toBe("socket-keepalive");
  for (const delaySeconds of [-1, 0x1_0000_0000, 1.5, NaN]) {
    expect(() => decodeBrokerEvent({ kind: "request", identity, operation: { kind: "socket-keepalive", fd: 7, enabled: true, delaySeconds } })).toThrow();
  }
});
