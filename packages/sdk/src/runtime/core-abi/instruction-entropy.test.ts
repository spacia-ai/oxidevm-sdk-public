import { expect, test } from "vitest";
import { instructionIdentities } from "../isa-identities.generated.ts";
import { decodeInstructionEntropy } from "./instruction-entropy.ts";

function capture(kind = 1): Uint8Array {
  const bytes = new Uint8Array(84);
  bytes.set(new TextEncoder().encode("OXEN"));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint32(8, 72, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(28, 42n, true);
  view.setBigUint64(36, 0x1234n, true);
  view.setBigUint64(44, 1n, true);
  view.setBigUint64(52, kind === 1 ? 0x9876n : 0n, true);
  const authority = instructionIdentities["rdrand-register"];
  view.setUint16(60, authority.formCode, true);
  view.setUint16(62, authority.semanticCode, true);
  view.setUint16(64, 0xa0fb, true);
  bytes.set([64, 8, 4, 3, 2, 1, 3, kind], 66);
  return bytes;
}

test("bounded entropy capture keeps generated identities and all replay context", () => {
  expect(decodeInstructionEntropy(capture())).toEqual({ dropped: 0n, records: [{
    sequence: 42n, instructionRip: 0x1234n, addressSpace: 1n, word: 0x9876n,
    ...instructionIdentities["rdrand-register"], instructionId: "rdrand-register",
    codeAttributes: 0xa0fb, width: 64, destination: 8, instructionLength: 4,
    mode: "long", profile: "x86-64-v3", capabilityRevision: 1, cpl: 3,
  }] });
  expect(decodeInstructionEntropy(capture(0)).records[0]?.word).toBe(null);
});

test("malformed entropy records reject wrong identity, bounds, contexts and reserved bytes", () => {
  const bytes = capture();
  for (const offset of [0, 4, 6, 8, 20, 24, 60, 62, 66, 67, 68, 69, 70, 71, 72, 73, 74]) {
    const malformed = bytes.slice();
    malformed[offset] = 255;
    expect(() => decodeInstructionEntropy(malformed), `offset ${String(offset)}`).toThrow();
  }
  for (const offset of [28, 44]) {
    const malformed = bytes.slice();
    malformed.fill(0, offset, offset + 8);
    expect(() => decodeInstructionEntropy(malformed)).toThrow();
  }
  expect(() => decodeInstructionEntropy(bytes.subarray(0, 83))).toThrow();
  const unavailable = bytes.slice();
  unavailable[73] = 0;
  expect(() => decodeInstructionEntropy(unavailable)).toThrow();
  const legacy = bytes.slice();
  legacy[69] = 1;
  expect(() => decodeInstructionEntropy(legacy)).toThrow();
});

test("dropped input records remain explicitly incomplete", () => {
  const bytes = capture();
  new DataView(bytes.buffer).setBigUint64(12, 3n, true);
  expect(decodeInstructionEntropy(bytes).dropped).toBe(3n);
});
