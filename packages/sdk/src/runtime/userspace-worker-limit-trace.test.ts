import { expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function trace(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT")); view.setUint16(4, 51, true);
  view.setUint32(8, 992, true); view.setUint32(12, 1, true);
  for (const [offset, value] of [[0, 1n], [8, 1n], [16, 1n], [32, 1n], [40, 0x5000n], [48, 0x5002n],
    [56, 427n], [64, 3n], [72, 19n], [80, 0x6000n], [88, 2n], [192, 11n], [200, 12n],
    [208, 99n], [216, 7n], [224, 31n], [232, 8n], [240, 41n], [248, 1n]] as const) view.setBigUint64(at + offset, value, true);
  view.setUint32(at + 24, 1, true); view.setUint32(at + 28, 2, true);
  bytes[at + 123] = 8; bytes[at + 256] = 1;
  for (const [offset, value] of [[288, 2], [292, 1024], [296, 7], [300, 11], [304, 7], [308, 11]] as const) view.setUint32(at + offset, value, true);
  return bytes;
}

it("retains each original pool update and caller account without a submitted request", () => {
  const snapshot = decodeUserspaceSyscallTrace(trace()), event = snapshot.events[0];
  expect(snapshot.version).toBe(51);
  expect(event).toMatchObject({ kind: "io-uring-worker-limits", number: 427n,
    operation: { ring: 11n, openFile: 12n, pool: 31n, poolCgroup: 8n, cpuCgroup: 7n,
      admittedGuestTicks: 41n, guestTicks: 99n, kernelUnits: 1, action: "applied",
      previous: [2, 1024], limits: [7, 11], requested: [7, 11] } });
});

it("keeps seccomp provenance separate from previous and committed worker limits", () => {
  const bytes = trace(), view = new DataView(bytes.buffer), at = 24;
  bytes[at + 272] = 3; view.setUint32(at + 276, 0x7fff0000, true); view.setBigUint64(at + 280, 23n, true);
  expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
    seccomp: { kind: "filter", programId: 23n, value: 0x7fff0000 }, operation: { previous: [2, 1024], limits: [7, 11] },
  });
  view.setUint32(at + 276, 0x50001, true);
  expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow(/malformed/u);
});

it("validates unchanged retiring pools and departed weak references", () => {
  const bytes = trace(), view = new DataView(bytes.buffer), at = 24;
  bytes[at + 256] = 2;
  expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow(/malformed/u);
  bytes.copyWithin(at + 296, at + 288, at + 296);
  expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ operation: { action: "retiring", limits: [2, 1024] } });
  bytes[at + 256] = 3; view.setBigUint64(at + 232, 0n, true); bytes.fill(0, at + 288, at + 304);
  expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ operation: { action: "departed" } });
  view.setBigUint64(at + 232, 8n, true);
  expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow(/malformed/u);
});

it("rejects legacy reinterpretation, malformed identity, uncharged work and changed limits", () => {
  for (const [offset, value] of [[56, 426n], [72, 27n], [80, 0n], [88, 1n], [192, 0n], [200, 0n],
    [208, 41n], [216, 0n], [224, 0n], [232, 0n], [248, 0n]] as const) {
    const bytes = trace(); new DataView(bytes.buffer).setBigUint64(24 + offset, value, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow(/malformed/u);
  }
  for (const [offset, value] of [[120, 2], [122, 11], [128, 1], [256, 0], [257, 1], [264, 1],
    [288, 255], [296, 8], [304, 8], [312, 1], [991, 1]] as const) {
    const bytes = trace(); bytes[24 + offset] = value;
    if (offset === 288) new DataView(bytes.buffer).setUint32(24 + offset, 0x80000000, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow(/malformed/u);
  }
  const bytes = trace(); new DataView(bytes.buffer).setUint16(4, 50, true);
  expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow(/malformed/u);
});
