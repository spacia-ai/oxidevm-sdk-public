import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function napiTurn(phase: 12 | 13): Uint8Array {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 32, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 427n, true); view.setBigUint64(offset + 64, 3n, true);
  view.setBigUint64(offset + 72, 27n, true); view.setBigUint64(offset + 80, 0x600800n, true);
  view.setBigUint64(offset + 88, 1n, true);
  bytes[offset + 120] = 2; bytes[offset + 122] = 11;
  view.setBigUint64(offset + 128, 7n, true); view.setBigUint64(offset + 136, 10n, true);
  bytes[offset + 192] = phase; bytes[offset + 193] = phase === 12 ? 3 : 2;
  view.setUint32(offset + 196, phase === 12 ? 1 : 128, true);
  view.setBigUint64(offset + 200, phase === 12 ? 11n : 138n, true);
  return bytes;
}

describe("syscall trace v32 NAPI registration turns", () => {
  it.each([[12, "napi"], [13, "napi-disposal"]] as const)("preserves phase %s as %s", (phase, name) => {
    expect(decodeUserspaceSyscallTrace(napiTurn(phase))).toMatchObject({ version: 32, events: [{
      number: 427n, wait: { kind: "io-uring-registration", phase: name, ringOpenFileId: 7n },
    }] });
  });
  it("requires the matching opcode and version for a NAPI retirement", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 31, true), view => view.setBigUint64(24 + 72, 28n, true),
      view => view.setBigUint64(24 + 72, 19n, true), view => view.setBigUint64(24 + 80, 0n, true),
      view => view.setBigUint64(24 + 88, 0n, true), view => view.setUint8(24 + 208, 1),
    ];
    for (const change of changes) {
      const bytes = napiTurn(13); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
