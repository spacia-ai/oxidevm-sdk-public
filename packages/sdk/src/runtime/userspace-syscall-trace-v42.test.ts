import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function fixedFileTrace(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 960), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 42, true); view.setUint32(8, 960, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 2, true); view.setUint32(at + 28, 2, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 3n, true); bytes[at + 120] = 2; bytes[at + 123] = 4;
  for (const [field, value] of [[192, 7n], [200, 8n], [208, 99n], [216, 50n], [224, 91n], [256, 57n], [288, 257n], [296, 8192n]] as const) {
    view.setBigUint64(at + field, value, true);
  }
  bytes[at + 232] = 4; bytes[at + 233] = 10; bytes[at + 234] = 1; bytes[at + 236] = 1;
  view.setUint32(at + 264, 65_536, true);
  return bytes;
}

describe("trace42 fixed-file final ring disposal", () => {
  it("retains a 32-bit slot and the exact description and capacity before one close", () => {
    expect(decodeUserspaceSyscallTrace(fixedFileTrace())).toMatchObject({ version: 42, events: [{
      kind: "io-uring-finalization", finalization: { done: false, progress: {
        kind: "files", phase: "file-descriptor", slot: 65_536, openFileId: 57n,
        descriptorsBefore: 257, metadataPagesBefore: 8192,
      } },
    }] });
  });

  it("distinguishes an empty fixed table from the released ring", () => {
    const bytes = fixedFileTrace(), view = new DataView(bytes.buffer), at = 24;
    bytes.fill(0, at + 256, at + 272); bytes.fill(0, at + 288, at + 304);
    bytes[at + 234] = 0; bytes[at + 233] = 11; view.setBigUint64(at + 296, 3n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ finalization: {
      done: false, progress: { kind: "files", phase: "file-metadata", metadataPagesBefore: 3 },
    } }] });
    bytes[at + 233] = 12; view.setBigUint64(at + 296, 0n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ finalization: {
      done: false, progress: { kind: "files", phase: "file-owner" },
    } }] });
  });

  it("rejects a historical header, unclaimed bytes and a premature released outcome", () => {
    const bytes = fixedFileTrace(), view = new DataView(bytes.buffer);
    view.setUint16(4, 41, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    for (const field of [268, 304, 312, 323, 440, 959]) {
      const invalid = fixedFileTrace(); invalid[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    const released = fixedFileTrace(); released[24 + 235] = 1; released[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(released)).toThrow();
  });
});
