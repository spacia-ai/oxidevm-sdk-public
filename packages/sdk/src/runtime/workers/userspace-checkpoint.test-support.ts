import { expect } from "vitest";
import { UserspaceCheckpoints } from "./userspace-checkpoint.js";
export const FRAME = 65536;
export function nativeGraphFixture(version = 1, marker = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(85), view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  tag(0, "OXUG"); view.setUint32(4, 1, true); view.setUint32(8, 2, true);
  view.setUint32(16, 49, true); tag(20, "OXWA"); view.setUint32(24, 1, true);
  bytes[28] = marker;
  view.setUint32(69, 1, true); view.setUint32(73, 8, true);
  tag(77, "OXUC"); view.setUint32(81, version, true);
  return bytes;
}
export function fixture(sealStatus = 0, abortFailures = 0, metadataStatus = 0, logicalVersion = 1) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  let frameLength = 0, stagedLength = 0;
  const attachment = new Uint8Array(49); attachment.set(new TextEncoder().encode("OXWA")); new DataView(attachment.buffer).setUint32(4, 1, true);
  const graph = new Uint8Array(FRAME); graph.set(new TextEncoder().encode("OXUC")); new DataView(graph.buffer).setUint32(4, logicalVersion, true);
  const payload = new Uint8Array(1024 * 1024 + 7).fill(0x5a);
  const events: string[] = [];
  const imported: Uint8Array[] = [];
  const frame = (bytes: Uint8Array) => { new Uint8Array(memory.buffer, FRAME, bytes.length).set(bytes); frameLength = bytes.length; return 0; };
  const exports: WebAssembly.Exports = {
    oxidevm_userspace_staging_resize: (length: number) => { stagedLength = length; return 0; },
    oxidevm_userspace_staging_ptr: () => 0,
    oxidevm_userspace_checkpoint_capture_begin: () => { events.push("capture"); return 7n; },
    oxidevm_userspace_checkpoint_restore_begin: () => { events.push("restore"); return 8n; },
    oxidevm_userspace_checkpoint_status: () => sealStatus,
    oxidevm_userspace_checkpoint_metadata_count: () => 2,
    oxidevm_userspace_checkpoint_metadata_read: (_token: bigint, index: number) => frame(index === 0 ? attachment : graph),
    oxidevm_userspace_checkpoint_payload_declarations: (_token: bigint, after: bigint) => {
      if (after !== 0n) return frame(new Uint8Array());
      const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
      view.setBigUint64(0, 3n, true); view.setBigUint64(16, BigInt(payload.length), true); return frame(bytes);
    },
    oxidevm_userspace_checkpoint_payload_read: (_token: bigint, _ref: bigint, offset: bigint) => frame(payload.subarray(Number(offset), Number(offset) + FRAME)),
    oxidevm_userspace_checkpoint_frame_ptr: () => FRAME,
    oxidevm_userspace_checkpoint_frame_len: () => frameLength,
    oxidevm_userspace_checkpoint_capture_finish: (_token: bigint, committed: number) => { events.push(`finish:${String(committed)}`); return 0; },
    oxidevm_userspace_checkpoint_abort: () => { events.push("abort"); return abortFailures-- > 0 ? 2 : 0; },
    oxidevm_userspace_checkpoint_metadata_push: (_token: bigint, index: number, length: number) => { expect(length).toBe(stagedLength); events.push(`metadata:${String(index)}`); return 0; },
    oxidevm_userspace_checkpoint_restore_phase: () => events.includes("allocated") ? 2 : 1,
    oxidevm_userspace_checkpoint_metadata_complete: () => { if (metadataStatus === 0) events.push("allocated"); return metadataStatus; },
    oxidevm_userspace_checkpoint_payload_push: (_token: bigint, _ref: bigint, _offset: bigint, length: number) => { imported.push(new Uint8Array(memory.buffer, 0, length).slice()); return 0; },
    oxidevm_userspace_checkpoint_restore_complete: () => { events.push("published"); return 0; },
  };
  return { memory, bridge: new UserspaceCheckpoints({ instance: { exports }, memory }, () => events.push("jit-invalidated")), events, imported, payload, exports, frame };
}
