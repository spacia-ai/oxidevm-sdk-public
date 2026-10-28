import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function queryWait(stage = 2): Uint8Array {
  const bytes = new Uint8Array(24 + 752);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 25, true); view.setUint32(8, 752, true); view.setUint32(12, 1, true);
  for (const offset of [0, 8, 16]) view.setBigUint64(24 + offset, 1n, true);
  for (const offset of [24, 28]) view.setUint32(24 + offset, 1, true);
  view.setBigUint64(24 + 32, 1n, true);
  view.setBigUint64(24 + 40, 0x401000n, true); view.setBigUint64(24 + 48, 0x401002n, true);
  view.setBigUint64(24 + 56, 427n, true);
  view.setBigUint64(24 + 64, 0xffff_ffffn, true); view.setBigUint64(24 + 72, 35n, true);
  view.setBigUint64(24 + 80, 0x600000n, true);
  view.setUint8(24 + 120, 2); view.setUint8(24 + 122, 10);
  view.setBigUint64(24 + 128, 0x600000n, true);
  view.setUint8(24 + 192, stage); view.setUint8(24 + 193, 1);
  if (stage !== 1) {
    view.setUint8(24 + 194, 1); view.setUint32(24 + 196, 2, true);
    view.setBigUint64(24 + 200, 0x610000n, true);
    view.setUint32(24 + 208, stage === 2 ? 80 : 0, true);
    view.setUint32(24 + 212, 4096, true);
  }
  return bytes;
}

describe("syscall trace v25 bounded registration queries", () => {
  it.each([1, 2, 3, 4])("decodes exact phase %s without guest-memory capture", stage => {
    expect(decodeUserspaceSyscallTrace(queryWait(stage)).events[0]).toMatchObject({
      kind: "syscall", number: 427n, outcome: { kind: "blocked" }, wait: {
        kind: "io-uring-query", ringOpenFileId: null, headerAddress: 0x600000n, completedQueries: 0,
        stage: ["header", "clear-tail", "payload", "copy-header"][stage - 1],
        operation: stage === 1 ? null : 2, dataAddress: stage === 1 ? 0n : 0x610000n,
        nextByte: stage === 2 ? 80 : 0, requestedBytes: stage === 1 ? 0 : 4096, reason: "turn-limit",
      },
    });
  });

  it("accepts CPU quota and low-word syscall arguments", () => {
    const bytes = queryWait(); const view = new DataView(bytes.buffer);
    view.setUint8(24 + 193, 2);
    view.setBigUint64(24 + 72, (0xabcdn << 32n) | 0x80000023n, true);
    view.setBigUint64(24 + 88, 0x123400000000n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]?.wait).toMatchObject({ reason: "cpu-quota" });
  });

  it("retains an admitted ring identity separately from its reusable descriptor", () => {
    const bytes = queryWait(); const view = new DataView(bytes.buffer);
    view.setBigUint64(24 + 64, 3n, true); view.setBigUint64(24 + 216, 11n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]?.wait).toMatchObject({ ringOpenFileId: 11n });
    view.setBigUint64(24 + 216, 0n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("rejects forged phases, source identity, copy cursors and reserved fields", () => {
    const mutations: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 24, true), view => view.setBigUint64(24 + 56, 426n, true),
      view => view.setBigUint64(24 + 72, 34n, true), view => view.setBigUint64(24 + 88, 1n, true),
      view => view.setUint8(24 + 120, 0), view => view.setUint8(24 + 123, 1),
      view => view.setBigUint64(24 + 128, 0x600040n, true),
      view => view.setBigUint64(24 + 136, 1001n, true),
      view => view.setUint8(24 + 192, 0), view => view.setUint8(24 + 192, 5),
      view => view.setUint8(24 + 193, 0), view => view.setUint8(24 + 193, 3),
      view => view.setUint8(24 + 194, 0), view => view.setUint8(24 + 194, 2),
      view => view.setUint8(24 + 195, 1), view => view.setUint32(24 + 208, 4097, true),
      view => view.setUint8(24 + 216, 1), view => view.setUint32(24 + 208, 17, true),
      view => view.setUint32(24 + 208, 4096, true), view => view.setUint8(24 + 264, 1),
      view => view.setUint8(24 + 272, 1),
    ];
    for (const mutate of mutations) {
      const bytes = queryWait(); mutate(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const bytes = queryWait(1); new DataView(bytes.buffer).setBigUint64(24 + 200, 1n, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
