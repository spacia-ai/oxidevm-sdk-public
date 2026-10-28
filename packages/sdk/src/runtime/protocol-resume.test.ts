import { describe, expect, it } from "vitest";

import { VMError } from "./errors.js";
import { controlResponseDecoders, decodeControlIncoming, PROTOCOL_VERSION } from "./protocol.js";

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };

describe("resumed guest-agent control operations", () => {
  it("attaches a page to a restored process through a transferred port", () => {
    const { port1, port2 } = new MessageChannel();
    const message = { id: 3, version: PROTOCOL_VERSION, type: "agent-attach-process", agentRequestId: 9, port: port1 };

    expect(decodeControlIncoming(message)).toMatchObject({ type: "agent-attach-process", agentRequestId: 9, port: port1 });
    for (const malformed of [
      { ...message, port: "port" },
      { ...message, agentRequestId: 0 },
      { ...message, extra: 1 },
      { ...message, version: 35 },
    ]) {
      expect(() => decodeControlIncoming(malformed)).toThrow(VMError);
    }
    port1.close();
    port2.close();
  });

  it("names the restore point whose workspace a resumed guest is reconciled from", () => {
    const message = { id: 4, version: PROTOCOL_VERSION, type: "agent-reconcile-workspace", snapshot: SNAPSHOT };

    expect(decodeControlIncoming(message)).toEqual(message);
    for (const malformed of [
      { ...message, snapshot: { ...SNAPSHOT, id: "latest" } },
      { ...message, snapshot: undefined },
      { ...message, extra: 1 },
      { ...message, version: 37 },
    ]) {
      expect(() => decodeControlIncoming(malformed)).toThrow(VMError);
    }
  });

  it("captures an automatic save, a named restore point or a named safety point", () => {
    const base = { id: 5, version: PROTOCOL_VERSION, type: "snapshot" };

    expect(decodeControlIncoming(base)).toEqual(base);
    expect(decodeControlIncoming({ ...base, label: "bun dev · 14:32" })).toMatchObject({ label: "bun dev · 14:32" });
    expect(decodeControlIncoming({ ...base, label: "Before restore", kind: "safety" })).toMatchObject({ kind: "safety" });
    for (const malformed of [
      { ...base, kind: "safety" },
      { ...base, kind: "automatic", label: "x" },
      { ...base, kind: "named", label: "  " },
      { ...base, label: "x".repeat(257) },
      { ...base, extra: 1 },
    ]) {
      expect(() => decodeControlIncoming(malformed), JSON.stringify(malformed)).toThrow(VMError);
    }
  });

  it("sets the page data later restore points carry, at most 1 MiB", () => {
    const base = { id: 6, version: PROTOCOL_VERSION, type: "snapshot-app-data" };

    expect(decodeControlIncoming({ ...base, data: new Uint8Array([1]) })).toMatchObject({ data: new Uint8Array([1]) });
    expect(decodeControlIncoming({ ...base, data: null })).toMatchObject({ data: null });
    for (const malformed of [base, { ...base, data: new Uint8Array(1024 * 1024 + 1) }, { ...base, data: "tabs" }, { ...base, data: null, extra: 1 }]) {
      expect(() => decodeControlIncoming(malformed)).toThrow(VMError);
    }
  });

  it("reads what a completed restore brought back strictly", () => {
    const decode = controlResponseDecoders.restore;
    const restored = {
      newerFilesDropped: true,
      appData: new Uint8Array([7]),
      consoleTail: new TextEncoder().encode("login: "),
      processes: [{ agentRequestId: 3, command: "bun dev", terminal: true, tail: new Uint8Array([1]) }],
    };

    expect(decode(restored)).toEqual(restored);
    expect(decode({ ...restored, appData: null, processes: [] })).toEqual({ ...restored, appData: null, processes: [] });
    for (const malformed of [
      { ...restored, newerFilesDropped: "yes" },
      { ...restored, consoleTail: new Uint8Array(64 * 1024 + 1) },
      { ...restored, processes: [{ ...restored.processes[0], agentRequestId: 0 }] },
      { ...restored, processes: [{ ...restored.processes[0], extra: 1 }] },
      { ...restored, extra: 1 },
      undefined,
    ]) {
      expect(() => decode(malformed)).toThrow(VMError);
    }
  });

  it("reads how a resumed guest's workspace was reconciled strictly", () => {
    const decode = controlResponseDecoders["agent-reconcile-workspace"];
    const result = { workspace: "conflict-preserved", unresolved: ["/workspace/package.json"] };

    expect(decode(result)).toEqual(result);
    for (const malformed of [
      { workspace: "merged", unresolved: [] },
      { workspace: "in-sync" },
      { workspace: "in-sync", unresolved: "none" },
      { workspace: "reconciled", unresolved: ["/etc/passwd"] },
      { workspace: "reconciled", unresolved: [], extra: true },
    ]) {
      expect(() => decode(malformed)).toThrow(VMError);
    }
  });
});

it("validates native workspace reconciliation on the completed restore boundary", () => {
  const result = { newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [],
    workspace: { workspace: "reconciled", unresolved: [] } };
  expect(controlResponseDecoders.restore(result)).toEqual(result);
  for (const workspace of [{ workspace: "merged", unresolved: [] }, { workspace: "conflict-preserved", unresolved: ["/etc/passwd"] },
    { workspace: "in-sync", unresolved: [], extra: true }]) {
    expect(() => controlResponseDecoders.restore({ ...result, workspace })).toThrow(VMError);
  }
});
