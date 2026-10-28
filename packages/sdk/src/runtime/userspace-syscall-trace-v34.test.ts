import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function wait(tag: 13 | 14): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(856), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 34, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 7, true); view.setUint32(offset + 28, 8, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, tag === 13 ? 426n : 59n, true);
  view.setBigUint64(offset + 64, 3n, true); view.setBigUint64(offset + 72, 1n, true);
  bytes[offset + 120] = 2; bytes[offset + 122] = tag;
  view.setBigUint64(offset + 128, tag === 13 ? 17n : 1n, true);
  view.setBigUint64(offset + 136, tag === 13 ? 11n : 1n, true);
  if (tag === 13) view.setBigUint64(offset + 192, 11n, true);
  else { view.setUint32(offset + 192, 2, true); view.setBigUint64(offset + 200, 7n, true); }
  return bytes;
}

describe("trace34 enter serialization", () => {
  it("retains the enter mutex and original admission time without an SQE identity", () => {
    expect(decodeUserspaceSyscallTrace(wait(13))).toMatchObject({ version: 34, events: [{
      kind: "syscall", number: 426n, wait: {
        kind: "io-uring-enter-mutex", ringOpenFileId: 17n, admittedGuestTicks: 11n, guestTicks: 11n,
      },
    }] });
  });

  it("rejects foreign calls, empty ordinary enters, invalid ring IDs, times and padding", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 33, true), view => view.setBigUint64(24 + 56, 427n, true),
      view => view.setBigUint64(24 + 72, 0n, true), view => view.setBigUint64(24 + 64, 0xffff_ffffn, true),
      view => view.setBigUint64(24 + 128, 0n, true), view => view.setBigUint64(24 + 128, 0xffff_ffff_ffff_ffffn, true),
      view => view.setBigUint64(24 + 192, 10n, true), view => view.setUint8(24 + 200, 1),
      view => view.setBigUint64(24 + 88, 256n, true),
    ];
    for (const change of changes) {
      const bytes = wait(13); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("distinguishes enter, registration and I/O request counts at teardown", () => {
    for (const [number, purpose, name] of [[59n, 1n, "exec"], [322n, 1n, "exec"], [231n, 2n, "exit-group"]] as const) {
      const bytes = wait(14), view = new DataView(bytes.buffer);
      view.setBigUint64(24 + 56, number, true); view.setBigUint64(24 + 136, purpose, true);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version: 34, events: [{ wait: {
        kind: "io-uring-enter-drain", purpose: name, pendingEnters: 1, pendingRegistrations: 2, pendingRequests: 7n,
      } }] });
    }
  });

  it("rejects invalid teardown counts, purpose, reserved bytes and legacy meanings", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 33, true), view => view.setBigUint64(24 + 56, 427n, true),
      view => view.setBigUint64(24 + 128, 0n, true), view => view.setBigUint64(24 + 128, 4097n, true),
      view => view.setUint32(24 + 192, 4096, true), view => view.setUint8(24 + 196, 1),
      view => view.setUint8(24 + 208, 1), view => view.setBigUint64(24 + 136, 4n, true),
    ];
    for (const change of changes) {
      const bytes = wait(14); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("requires the retained seccomp process-kill decision", () => {
    const bytes = wait(14), view = new DataView(bytes.buffer);
    view.setBigUint64(24 + 56, 39n, true); view.setBigUint64(24 + 136, 3n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    bytes[24 + 272] = 3;
    view.setUint32(24 + 276, 0x8000_0000, true); view.setBigUint64(24 + 280, 7n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ wait: { kind: "io-uring-enter-drain", purpose: "seccomp-process-kill" } });
    view.setUint32(24 + 276, 0x7fff_0000, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
