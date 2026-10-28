import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function copyWait(reason = 1, copied = 65536n): Uint8Array {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 52, true); view.setUint32(8, 992, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  for (const field of [24, 28]) view.setUint32(offset + field, 1, true);
  view.setBigUint64(offset + 40, 0x401000n, true); view.setBigUint64(offset + 48, 0x401002n, true);
  view.setBigUint64(offset + 56, 326n, true);
  view.setBigUint64(offset + 64, 3n, true); view.setBigUint64(offset + 80, 4n, true);
  view.setBigUint64(offset + 96, 65545n, true);
  view.setUint8(offset + 120, 2); view.setUint8(offset + 122, 17);
  view.setBigUint64(offset + 128, copied, true); view.setBigUint64(offset + 136, 65545n, true);
  view.setUint8(offset + 192, reason);
  return bytes;
}

describe("trace52 bounded file copies", () => {
  it("retains exact copy progress and its original syscall", () => {
    expect(decodeUserspaceSyscallTrace(copyWait())).toMatchObject({ version: 52, events: [{
      number: 326n, outcome: { kind: "blocked" }, wait: {
        kind: "file-copy", copiedBytes: 65536n, totalBytes: 65545n, reason: "chunk-bound",
      },
    }] });
  });

  it("distinguishes CPU quota before the first chunk", () => {
    expect(decodeUserspaceSyscallTrace(copyWait(2, 0n)).events[0]?.wait).toMatchObject({
      kind: "file-copy", copiedBytes: 0n, reason: "cpu-quota",
    });
  });

  it("keeps copy progress when the scheduler resumes a runnable task", () => {
    const bytes = copyWait(); new DataView(bytes.buffer).setUint8(24 + 120, 1);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "resumed" }, wait: { kind: "file-copy", copiedBytes: 65536n },
    });
  });

  it("rejects stale versions, unrelated calls, impossible progress and reserved bytes", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 51, true), view => view.setBigUint64(24 + 56, 325n, true),
      view => view.setUint8(24 + 192, 3), view => view.setUint8(24 + 193, 1),
      view => view.setBigUint64(24 + 128, 1n, true), view => view.setBigUint64(24 + 128, 0n, true),
      view => view.setBigUint64(24 + 128, 131072n, true), view => view.setBigUint64(24 + 136, 65536n, true),
      view => view.setBigUint64(24 + 136, 65546n, true), view => view.setBigUint64(24 + 104, 1n, true),
      view => view.setUint8(24 + 120, 0), view => view.setUint8(24 + 123, 1),
      view => view.setBigUint64(24 + 64, 0xffff_ffffn, true),
      view => view.setBigUint64(24 + 80, 0xffff_ffffn, true),
      view => view.setBigUint64(24 + 72, 0xffff_ffff_ffff_ffffn, true),
      view => view.setBigUint64(24 + 88, 0xffff_ffff_ffff_ffffn, true),
    ];
    for (const change of changes) {
      const bytes = copyWait(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
