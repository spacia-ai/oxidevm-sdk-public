import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function storageWait(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 552), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 13, true); view.setUint32(8, 552, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 120] = 2; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  bytes[offset + 232] = 3; bytes[offset + 234] = 3;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 272] = 3; view.setUint32(offset + 276, 0x7fff_0000, true);
  view.setBigUint64(offset + 280, 17n, true);
  bytes[offset + 512] = 1; bytes[offset + 513] = 3;
  for (const [field, value] of [[520, 9n], [528, 11n], [536, 13n], [544, 15n]] as const) {
    view.setBigUint64(offset + field, value, true);
  }
  return bytes;
}

describe("Userspace trace v13 durability waits", () => {
  it("keeps storage identity, both captured generations and the original seccomp decision", () => {
    expect(decodeUserspaceSyscallTrace(storageWait())).toMatchObject({ version: 13, events: [{
      kind: "io-uring-work", outcome: { kind: "blocked" },
      work: { completion: "waiting", done: false, wait: {
        kind: "durability", generation: 9n, id: 11n, root: 13n, workspace: 15n,
      } },
      seccomp: { kind: "filter", programId: 17n, value: 0x7fff_0000 },
    }] });
  });

  it("rejects missing identities, contradictory scopes, overlapping waits and reserved data", () => {
    for (const [field, value] of [[512, 0], [512, 2], [513, 0], [513, 1], [513, 4], [514, 1],
      [520, 0], [528, 0], [536, 0], [544, 0], [248, 1], [120, 0], [233, 1], [234, 2]] as const) {
      const bytes = storageWait(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    }
  });

  it.each([1, 2])("admits a single captured filesystem with flags %s", (flags) => {
    const bytes = storageWait(), view = new DataView(bytes.buffer);
    bytes[24 + 513] = flags;
    view.setBigUint64(24 + (flags === 1 ? 544 : 536), 0n, true);
    const event = decodeUserspaceSyscallTrace(bytes).events[0];
    if (event?.kind !== "io-uring-work" || event.work.completion !== "waiting"
      || event.work.wait.kind !== "durability") throw new Error("durability wait missing");
    expect(event.work.wait.root).toBe(flags === 1 ? 13n : undefined);
    expect(event.work.wait.workspace).toBe(flags === 2 ? 15n : undefined);
  });

  it("retains readiness waits in the new envelope without interpreting them as storage", () => {
    const bytes = storageWait(), view = new DataView(bytes.buffer);
    bytes.fill(0, 24 + 512);
    view.setBigUint64(24 + 248, 23n, true); view.setUint32(24 + 256, 1, true);
    view.setBigUint64(24 + 264, 25n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      work: { completion: "waiting", wait: { kind: "readiness", openFileId: 23n, events: 1, wakeups: 25n } },
    });
  });

  it("requires an empty extension on completed work and ordinary syscalls", () => {
    for (const work of [true, false]) {
      const bytes = storageWait(); bytes[24 + 120] = 0; bytes[24 + 234] = 2;
      if (!work) bytes[24 + 123] = 0;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    }
  });
});
