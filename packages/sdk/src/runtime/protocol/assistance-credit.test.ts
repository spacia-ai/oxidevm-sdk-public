import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeAssistanceCredit, encodeAssistanceCredit, matchAssistanceCreditReply } from "./assistance-credit.ts";

it.each([6, 7] as const)("v%s credits bind VM producers and process producers without changing v5 admission", version => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/credit-v6.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const [name, hex] = line.split(" ");
    if (name === undefined || hex === undefined) throw new Error("invalid fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const message = decodeAssistanceCredit(bytes, version);
    expect(message.producer).toBe(name.replace(/-return$/u, ""));
    expect(message.kind).toBe(name.endsWith("-return") ? "return" : "grant");
    expect(message.sequence).toBe(0xffff_ffff);
    expect(message.process).toBe(["network", "storage", "installation", "installation-gateway", "installation-process"].includes(message.producer) ? null : 0xffff_ffff);
    expect(encodeAssistanceCredit(message, version)).toEqual(bytes);
    expect(matchAssistanceCreditReply(message, bytes, version)).toEqual(message);
    expect(() => decodeAssistanceCredit(bytes)).toThrow();
    expect(() => encodeAssistanceCredit(message)).toThrow();
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceCredit(bytes.slice(0, end), version)).toThrow();
    expect(() => decodeAssistanceCredit(Uint8Array.from([...bytes, 0]), version)).toThrow();
    expect(() => encodeAssistanceCredit({ ...message, process: message.process === null ? 1 : null }, version)).toThrow();
  }
});

it("shares bounded v5 credit identities and rejects ambiguous authority", () => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/credit-v5.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const [name, hex] = line.split(" ");
    if (hex === undefined) throw new Error("invalid fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const message = decodeAssistanceCredit(bytes);
    expect(encodeAssistanceCredit(message)).toEqual(bytes);
    expect(message.producer).toBe(name === "broker-return" ? "broker" : name);
    expect(message.kind).toBe(name === "broker-return" ? "return" : "grant");
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceCredit(bytes.slice(0, end))).toThrow();
    expect(() => decodeAssistanceCredit(Uint8Array.from([...bytes, 0]))).toThrow();
    for (const patch of [{ extra: true }, { sequence: 0 }, { reservation: 0 }, { bytes: 0 }, { entries: 0 },
      { producer: "unknown" }, { pool: "unknown" }, { kind: "unknown" }, { bytes: 16 * 1024 * 1024 }, { entries: 4097 },
      { process: message.process === null ? 1 : null }]) {
      expect(() => encodeAssistanceCredit({ ...message, ...patch })).toThrow();
    }
  }
});

it("correlates grant and return replies with the complete issued reservation", () => {
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1,
    sequence: 1, reservation: 1, producer: "guest", kind: "grant", pool: "data", bytes: 1024, entries: 1 } as const;
  expect(matchAssistanceCreditReply(request, encodeAssistanceCredit(request))).toEqual(request);
  for (const patch of [{ generation: 2 }, { process: 2 }, { sequence: 2 }, { reservation: 2 }, { kind: "return" }, { bytes: 1023 }, { entries: 2 }]) {
    expect(() => matchAssistanceCreditReply(request, encodeAssistanceCredit({ ...request, ...patch }))).toThrow();
  }
});
