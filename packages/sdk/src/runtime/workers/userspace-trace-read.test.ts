import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, MAX_USERSPACE_SYSCALL_TRACE_BYTES } from "../userspace-abi.js";
import { readUserspaceSyscallTrace } from "./userspace-trace-read.js";

const MEMORY_PAGES = 64;

function runtime(length: number, pointer = 1024, status = 0) {
  const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES });
  const exports: WebAssembly.Exports = {
    oxidevm_userspace_syscall_trace_snapshot: () => status,
    oxidevm_userspace_syscall_trace_drain: () => status,
    oxidevm_userspace_syscall_trace_ptr: () => pointer,
    oxidevm_userspace_syscall_trace_len: () => length,
  };
  return { instance: { exports }, memory };
}

describe("Userspace syscall trace capture", () => {
  // Wire dimensions are intentionally independent of the reader's byte limit.
  // Rust trace v26 writes 784-byte records; v27 through current v31 write 832.
  describe.each(["snapshot", "drain"] as const)("%s", mode => {
    it.each([[26, 784], [27, 832], [28, 832], [29, 832], [30, 832], [31, 832]] as const)(
      "copies and decodes every record of a full v%i trace", (version, recordLength) => {
        const count = 4096, length = 24 + count * recordLength;
        const current = runtime(length);
        const source = new Uint8Array(current.memory.buffer, 1024, length);
        const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
        source.set(new TextEncoder().encode("OXLT"));
        view.setUint16(4, version, true);
        view.setUint32(8, recordLength, true);
        view.setUint32(12, count, true);
        for (let index = 0; index < count; index++) {
          const offset = 24 + index * recordLength, sequence = BigInt(index + 1);
          view.setBigUint64(offset, sequence, true);
          view.setBigUint64(offset + 8, sequence, true);
          view.setBigUint64(offset + 16, 1n, true);
          view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 1, true);
          view.setBigUint64(offset + 32, 1n, true);
          view.setBigUint64(offset + 40, 0x1000n, true);
          view.setBigUint64(offset + 48, 0x1002n, true);
          view.setBigUint64(offset + 56, 39n, true);
          view.setBigInt64(offset + 112, 1n, true);
        }
        const trace = readUserspaceSyscallTrace(current, mode);
        expect(trace.byteLength).toBe(length);
        const decoded = decodeUserspaceSyscallTrace(trace);
        expect(decoded.version).toBe(version);
        expect(decoded.dropped).toBe(0n);
        expect(decoded.events).toHaveLength(count);
        expect(decoded.events.at(-1)).toMatchObject({ sequence: 4096n, outcome: { kind: "result", value: 1n } });
        const resultOffset = 24 + (count - 1) * recordLength + 112;
        view.setBigInt64(resultOffset, 99n, true);
        expect(new DataView(trace.buffer, trace.byteOffset, trace.byteLength).getBigInt64(resultOffset, true)).toBe(1n);
      },
    );
  });

  it.each([
    ["short", runtime(23)],
    ["oversized", runtime(MAX_USERSPACE_SYSCALL_TRACE_BYTES + 1)],
    ["outside memory", runtime(24, MEMORY_PAGES * 65_536 - 23)],
    ["negative pointer", runtime(24, -1)],
  ])("rejects a %s export", (_name, current) => {
    expect(() => readUserspaceSyscallTrace(current)).toThrow("syscall trace export is invalid");
  });

  it("preserves an encoding failure", () => {
    expect(() => readUserspaceSyscallTrace(runtime(24, 1024, 2))).toThrow("failed with status 2");
  });

  it("requires the versioned drain export and preserves its errors", () => {
    expect(() => readUserspaceSyscallTrace(runtime(24, 1024, 2), "drain")).toThrow("syscall_trace_drain failed with status 2");
    expect(readUserspaceSyscallTrace(runtime(24), "drain").length).toBe(24);
  });
});
