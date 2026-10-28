import { expect, it } from "vitest";
import { encodeNativeAttachments, decodeNativeAttachments, appendNativeTail, nativeAttachmentCommand, type NativeAttachment } from "./userspace-attachments.js";

const process: NativeAttachment = { key: 3, identityKey: 2, pid: 23, command: "/bin/sh", terminal: { columns: 91, rows: 32 },
  stdinOpen: true, sequence: 12, acknowledged: 11, pending: { stream: "stdout", count: 3 }, tail: new Uint8Array([1, 2]) };

it("preserves stable process keys, PTY dimensions and the output acknowledgement cut", () => {
  const state = { nextKey: 5, processes: [process, { ...process, key: 4, identityKey: 1, pid: 42, command: "bun dev", terminal: undefined }] };
  expect(decodeNativeAttachments(encodeNativeAttachments(state))).toEqual(state);
  expect(appendNativeTail(new Uint8Array(65536).fill(1), new Uint8Array([2, 3]))).toEqual(
    new Uint8Array([...new Uint8Array(65534).fill(1), 2, 3]));
});

it("preserves zero terminal dimensions set by the guest", () => {
  const state = { nextKey: 5, processes: [{ ...process, command: "", tail: new Uint8Array(), terminal: { columns: 0, rows: 32 } }] };
  expect(decodeNativeAttachments(encodeNativeAttachments(state))).toEqual(state);
  expect(new TextEncoder().encode(nativeAttachmentCommand("λ".repeat(4096))).length).toBe(4096);
});

it("refuses duplicate identities, inconsistent acknowledgements and malformed framing", () => {
  for (const processes of [[process, process], [{ ...process, acknowledged: 13 }], [{ ...process, pending: undefined }]]) {
    expect(() => encodeNativeAttachments({ nextKey: 5, processes })).toThrow();
  }
  const bytes = encodeNativeAttachments({ nextKey: 5, processes: [process] });
  for (const end of [0, 4, 15, bytes.length - 1]) expect(() => decodeNativeAttachments(bytes.slice(0, end))).toThrow();
  bytes[4] = 2;
  expect(() => decodeNativeAttachments(bytes)).toThrow();
});

it("retains every supported attachment while bounding diagnostic tails", () => {
  const processes = Array.from({ length: 700 }, (_, index) => ({ ...process, key: index + 1, identityKey: index + 1, pid: index + 1, tail: new Uint8Array(65536).fill(index % 256) }));
  const bytes = encodeNativeAttachments({ nextKey: 701, processes });
  expect(bytes.length).toBeLessThanOrEqual(40 * 1024 ** 2);
  const restored = decodeNativeAttachments(bytes);
  expect(restored.processes).toHaveLength(700);
  expect(restored.processes.every(process => process.tail.length > 0 && process.tail.length < 65536)).toBe(true);
});
