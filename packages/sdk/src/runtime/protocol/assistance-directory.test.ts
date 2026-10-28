import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeBrokerCommand } from "./assistance-broker.js";
import { decodeAssistanceRequest, encodeAssistanceRequest } from "./assistance.js";
import { decodeAssistanceReply, encodeAssistanceReply, matchAssistanceReply } from "./assistance-reply.js";

it("shares guest7 directory bytes and rejects malformed or legacy replies", () => {
  const rows = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-directory-v7.hex", import.meta.url), "utf8").trim().split("\n").map(line => {
    const hex = line.split(" ")[1];
    if (hex === undefined) throw new Error("fixture");
    return new Uint8Array(Buffer.from(hex, "hex"));
  });
  const requestBytes = rows[0]; const replyBytes = rows[1];
  if (requestBytes === undefined || replyBytes === undefined) throw new Error("fixture");
  const request = decodeAssistanceRequest(requestBytes);
  expect(request.operation).toEqual({ kind: "readdir-entries", path: "./routes" });
  expect(encodeAssistanceRequest(request)).toEqual(requestBytes);
  const reply = decodeAssistanceReply(replyBytes, 7);
  expect(matchAssistanceReply(request, reply)).toEqual({ kind: "entries", entries: [
    { name: "directory", mode: 0o040000 }, { name: "file", mode: 0o100000 }, { name: "link", mode: 0o120000 },
  ] });
  expect(encodeAssistanceReply(reply, 7)).toEqual(replyBytes);
  const identity = { session: reply.session, generation: reply.generation, process: reply.process, sequence: reply.sequence };
  expect(decodeBrokerCommand({ kind: "reply", identity, bytes: replyBytes })).toEqual({ kind: "reply", identity, bytes: replyBytes });
  for (const version of [4, 5, 6]) {
    expect(() => decodeAssistanceReply(replyBytes, version)).toThrow();
    expect(() => encodeAssistanceReply(reply, version)).toThrow();
  }
  for (let end = 0; end < requestBytes.length; end++) expect(() => decodeAssistanceRequest(requestBytes.slice(0, end))).toThrow();
  for (let end = 0; end < replyBytes.length; end++) expect(() => decodeAssistanceReply(replyBytes.slice(0, end), 7)).toThrow();
  for (const entries of [[{ name: "..", mode: 0o040000 }], [{ name: "a/b", mode: 0o100000 }], [{ name: "a", mode: 0o100777 }]]) {
    expect(() => encodeAssistanceReply({ ...reply, result: { kind: "entries", entries } }, 7)).toThrow();
  }
});
