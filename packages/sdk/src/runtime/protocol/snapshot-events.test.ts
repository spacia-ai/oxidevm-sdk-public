import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { controlResponseDecoders, decodeControlIncoming, decodeSnapshotEventMessage, PROTOCOL_VERSION } from "../protocol.js";

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };

describe("restore point events", () => {
  it("restores native process attachments without guest-agent request identities", () => {
    const native = { mode: "userspace", attachmentKey: 7, terminalKey: 2, pid: 23, command: "/bin/sh", terminal: true, tail: new Uint8Array([10]) };
    const restored = { newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [native] };
    expect(controlResponseDecoders.restore(restored)).toEqual(restored);
    for (const process of [{ ...native, agentRequestId: 7 }, { ...native, pid: 0 }, { ...native, mode: "unknown" }]) {
      expect(() => controlResponseDecoders.restore({ ...restored, processes: [process] })).toThrow();
    }
  });
  it("reads each event a VM's restore points send strictly", () => {
    const events = [
      { type: "save-started", kind: "automatic" },
      { type: "save-finished", kind: "named", snapshot: SNAPSHOT, pauseMilliseconds: 142, durationMilliseconds: 2_310 },
      { type: "save-failed", kind: "automatic", error: { code: "QUOTA_EXCEEDED", message: "the browser has no room" } },
      { type: "auto-save-paused", reason: "quota", retryInMilliseconds: 60_000 },
      { type: "restore-progress", completedBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 },
      { type: "image-preparation-progress", completedBytes: 1, totalBytes: 2 },
      { type: "image-prepared" },
      { type: "image-preparation-failed", error: {code:"STORAGE_ERROR",message:"unavailable"} },
    ];
    for (const event of events) {
      expect(decodeSnapshotEventMessage({ version: PROTOCOL_VERSION, event })).toEqual(event);
    }
    for (const malformed of [
      { version: PROTOCOL_VERSION - 1, event: events[0] },
      { version: PROTOCOL_VERSION, event: { type: "save-started", kind: "favourite" } },
      { version: PROTOCOL_VERSION, event: { ...events[1], extra: 1 } },
      { version: PROTOCOL_VERSION, event: { ...events[1], pauseMilliseconds: -1 } },
      { version: PROTOCOL_VERSION, event: { type: "restore-progress", completedBytes: 2, totalBytes: 1 } },
      { version: PROTOCOL_VERSION, event: { type: "auto-save-paused", reason: "tired", retryInMilliseconds: 1 } },
      { version: PROTOCOL_VERSION, event: events[0], extra: true },
    ]) {
      expect(() => decodeSnapshotEventMessage(malformed), JSON.stringify(malformed)).toThrow(VMError);
    }
  });

  it("decodes the automatic save controls and the event port exactly", () => {
    const { port1, port2 } = new MessageChannel();
    const base = { id: 9, version: PROTOCOL_VERSION };

    expect(decodeControlIncoming({ ...base, type: "snapshot-events", port: port1 })).toMatchObject({ type: "snapshot-events" });
    expect(decodeControlIncoming({ ...base, type: "auto-save-configure", enabled: true })).toMatchObject({ enabled: true });
    expect(decodeControlIncoming({ ...base, type: "auto-save-hint", hint: "hidden" })).toMatchObject({ hint: "hidden" });
    for (const malformed of [
      { ...base, type: "snapshot-events", port: "port" },
      { ...base, type: "auto-save-configure", enabled: "yes" },
      { ...base, type: "auto-save-configure", enabled: true, intervalMilliseconds: 1 },
      { ...base, type: "auto-save-hint", hint: "scrolled" },
    ]) {
      expect(() => decodeControlIncoming(malformed), JSON.stringify(malformed)).toThrow(VMError);
    }
    expect(() => { controlResponseDecoders["auto-save-hint"](undefined); }).not.toThrow();
    expect(() => { controlResponseDecoders["auto-save-hint"]("saved"); }).toThrow(VMError);
    port1.close();
    port2.close();
  });
});
