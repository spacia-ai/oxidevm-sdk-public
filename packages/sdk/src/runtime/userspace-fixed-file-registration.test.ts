import { expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";
import { decodeUserspaceRegistrationFailure } from "./workers/userspace-registration-failure.ts";
import { record } from "./workers/userspace-registration-failure.fixtures.ts";
import { NATIVE_LOGICAL_CHECKPOINT_VERSION, supportsNativeCheckpointVersion } from "./protocol/native-capture.ts";

function trace(phase: number, operation: bigint): Uint8Array {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 30, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 427n, true); view.setBigUint64(offset + 72, operation, true);
  bytes[offset + 120] = 2; bytes[offset + 122] = 11;
  view.setBigUint64(offset + 128, 7n, true); view.setBigUint64(offset + 136, 10n, true);
  bytes[offset + 192] = phase; bytes[offset + 193] = 2;
  view.setUint32(offset + 196, 128, true); view.setBigUint64(offset + 200, 138n, true);
  return bytes;
}

it("decodes bounded file imports and rollback only in trace30", () => {
  for (const [phase, name] of [[10, "files"], [11, "file-disposal"]] as const) {
    for (const operation of [2n, 3n, 0x8000_0002n, 0x8000_0003n]) {
      const bytes = trace(phase, operation), view = new DataView(bytes.buffer);
      expect(decodeUserspaceSyscallTrace(bytes).version).toBe(30);
      expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ wait: {
        phase: name, reason: "turn-limit", ringOpenFileId: 7n, kernelUnits: 128,
      } });
      view.setUint16(4, 29, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  }
  expect(() => decodeUserspaceSyscallTrace(trace(10, 0n))).toThrow();
});

it("retains fixed-file invariant failures in OXRF2 and refuses legacy reinterpretation", () => {
  for (const [reason, name] of [[15, "file-description"], [16, "missing-ring"], [17, "published-state-changed"], [18, "private-state-shared"], [19, "metadata-shared"], [20, "resource-release"], [21, "private-state-poisoned"]] as const) {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint16(4, 2, true); bytes[112] = 11; bytes[113] = reason;
    expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({ phase: "file-disposal", reason: name });
    view.setUint16(4, 1, true);
    expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow();
  }
});

it("admits native70 private prefixes and refuses future native versions", () => {
  expect(supportsNativeCheckpointVersion(70)).toBe(true);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});
