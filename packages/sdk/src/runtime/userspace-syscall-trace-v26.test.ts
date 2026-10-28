import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function record(stage = 2): Uint8Array {
  const bytes = new Uint8Array(24 + 784), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 26, true); view.setUint32(8, 784, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  for (const field of [24, 28]) view.setUint32(offset + field, 1, true);
  view.setBigUint64(offset + 40, 0x401000n, true); view.setBigUint64(offset + 48, 0x401002n, true);
  view.setBigUint64(offset + 56, 427n, true); view.setBigUint64(offset + 72, 1n, true);
  view.setUint8(offset + 123, 2); view.setUint8(offset + 752, stage);
  view.setUint16(offset + 754, 7, true); view.setUint32(offset + 756, stage === 1 ? 0 : 9, true);
  view.setBigUint64(offset + 760, 11n, true); view.setBigUint64(offset + 768, 31n, true);
  view.setBigUint64(offset + 776, 99n, true);
  return bytes;
}

describe("syscall trace v26 registered buffer tag publications", () => {
  it.each([1, 2])("decodes exact tag resource identity and stage %s", stage => {
    expect(decodeUserspaceSyscallTrace(record(stage)).events[0]).toMatchObject({
      kind: "io-uring-buffer-tag", number: 427n, outcome: { kind: "result", value: 0n },
      tag: { ringObjectId: 11n, resourceOrigin: 31n, resourceIndex: 7, value: 99n,
        ...(stage === 1 ? { state: "queued" } : { state: "published", cqSequence: 9 }) },
    });
  });
  it("keeps wrapped CQ sequences, full-width tags and shifted byte views", () => {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint32(24 + 756, 0xffff_ffff, true); view.setBigUint64(24 + 776, 0xffff_ffff_ffff_ffffn, true);
    const shifted = new Uint8Array(bytes.length + 11); shifted.set(bytes, 7);
    expect(decodeUserspaceSyscallTrace(shifted.subarray(7, 7 + bytes.length)).events[0]).toMatchObject({
      tag: { state: "published", cqSequence: 0xffff_ffff, value: 0xffff_ffff_ffff_ffffn },
    });
  });
  it("rejects forged source, state, resource identity and reserved fields", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 25, true), view => view.setBigUint64(24 + 56, 1n, true),
      view => view.setUint8(24 + 120, 2), view => view.setBigInt64(24 + 112, 1n, true),
      view => view.setUint8(24 + 122, 1), view => view.setUint8(24 + 192, 1),
      view => view.setUint8(24 + 296, 1), view => view.setUint8(24 + 624, 1),
      view => view.setUint8(24 + 752, 0), view => view.setUint8(24 + 752, 3),
      view => view.setUint8(24 + 753, 1), view => view.setUint16(24 + 754, 16384, true),
      view => view.setBigUint64(24 + 760, 0n, true), view => view.setBigUint64(24 + 768, 0n, true),
      view => view.setBigUint64(24 + 776, 0n, true),
      view => { view.setUint8(24 + 752, 1); view.setUint32(24 + 756, 1, true); },
    ];
    for (const change of changes) { const bytes = record(); change(new DataView(bytes.buffer)); expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow(); }
  });
  it("rejects resource payloads on ordinary syscall and worker records", () => {
    const bytes = record(); bytes[24 + 123] = 0;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
