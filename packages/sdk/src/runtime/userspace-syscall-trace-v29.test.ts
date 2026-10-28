import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function registrationDrain(number = 59n, purpose = 1n): Uint8Array {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 29, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, number, true);
  bytes[offset + 120] = 2; bytes[offset + 122] = 12;
  view.setBigUint64(offset + 128, 1n, true); view.setBigUint64(offset + 136, purpose, true);
  return bytes;
}

describe("syscall trace v29 registration teardown barriers", () => {
  it("identifies a bounded registration turn under its original admitted call", () => {
    const bytes = registrationDrain(427n), view = new DataView(bytes.buffer);
    bytes[24 + 122] = 11;
    view.setBigUint64(24 + 128, 7n, true); view.setBigUint64(24 + 136, 10n, true);
    bytes[24 + 192] = 4; bytes[24 + 193] = 2;
    view.setUint32(24 + 196, 128, true); view.setBigUint64(24 + 200, 138n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version: 29, events: [{
      number: 427n, wait: { kind: "io-uring-registration", phase: "buffer", reason: "turn-limit",
        ringOpenFileId: 7n, admittedGuestTicks: 10n, guestTicks: 138n, kernelUnits: 128 },
    }] });
    for (const [field, value] of [[192, 0], [193, 0], [194, 1], [196, 127], [208, 1]] as const) {
      const malformed = bytes.slice(); malformed[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(malformed)).toThrow();
    }
    view.setBigUint64(24 + 200, 9n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("distinguishes registration owners from I/O requests when exec waits", () => {
    for (const number of [59n, 322n]) {
      const bytes = registrationDrain(number);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version: 29, events: [{
        tid: 2, number, outcome: { kind: "blocked" }, wait: {
          kind: "io-uring-registration-drain", purpose: "exec", pendingRegistrations: 1,
          pendingRequests: 0n,
        },
      }] });
    }
  });

  it("preserves both pending counts for exit_group", () => {
    const bytes = registrationDrain(231n, 2n);
    new DataView(bytes.buffer).setBigUint64(24 + 192, 7n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ wait: {
      kind: "io-uring-registration-drain", purpose: "exit-group", pendingRegistrations: 1,
      pendingRequests: 7n,
    } });
  });

  it("requires the original fatal seccomp decision for a process-kill barrier", () => {
    const bytes = registrationDrain(39n, 3n), view = new DataView(bytes.buffer);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    bytes[24 + 272] = 3;
    view.setBigUint64(24 + 280, 7n, true); view.setUint32(24 + 276, 0x8000_0000, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      number: 39n, wait: { kind: "io-uring-registration-drain", purpose: "seccomp-process-kill" },
      seccomp: { kind: "filter", programId: 7n, value: 0x8000_0000 },
    });
    view.setUint32(24 + 276, 0x7fff_0000, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("refuses old wire meanings, foreign syscalls, invalid counts and reserved bytes", () => {
    for (const change of [
      (view: DataView): void => view.setUint16(4, 28, true),
      (view: DataView): void => view.setBigUint64(24 + 56, 427n, true),
      (view: DataView): void => view.setBigUint64(24 + 128, 0n, true),
      (view: DataView): void => view.setBigUint64(24 + 128, 4097n, true),
      (view: DataView): void => view.setBigUint64(24 + 136, 9n, true),
      (view: DataView): void => view.setUint8(24 + 200, 1),
      (view: DataView): void => view.setUint8(24 + 120, 0),
    ]) {
      const bytes = registrationDrain(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
