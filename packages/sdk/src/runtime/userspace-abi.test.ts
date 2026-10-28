import { Writer } from "./js-process/codec.js";
import { describe, expect, it } from "vitest";

import {
  USERSPACE_API_VERSION,
  decodeUserspaceKernelAccountingModel,
  decodeUserspaceHostRequest,
  decodeUserspacePendingWork,
  decodeUserspaceStdinCount,
  decodeUserspaceWaitStatus,
  decodeUserspaceRunResult,
  decodeUserspaceSyscallTrace,
  encodeUserspaceArguments,
  encodeUserspaceHostCompletion,
  encodeUserspaceNetworkHostCompletion,
  encodeUserspaceDurabilityHostCompletion,
} from "./userspace-abi.js";

describe("Userspace Wasm records", () => {
  it("decodes v8 rseq revocation waits with exact deadlines and reasons", () => {
    const trace = new Uint8Array(24 + 288), view = new DataView(trace.buffer);
    trace.set(new TextEncoder().encode("OXLT"));
    view.setUint16(4, 8, true); view.setUint32(8, 288, true); view.setUint32(12, 1, true);
    for (const offset of [24, 32, 40, 56]) view.setBigUint64(offset, 1n, true);
    view.setUint32(48, 1, true); view.setUint32(52, 1, true);
    view.setBigUint64(64, 0x1000n, true); view.setBigUint64(72, 0x1002n, true);
    view.setBigUint64(80, 471n, true); trace[24 + 120] = 2; trace[24 + 122] = 6;
    view.setBigUint64(24 + 128, 12_800n, true);
    for (const [value, reason] of [[1n, "syscall"], [2n, "expiry"]] as const) {
      view.setBigUint64(24 + 136, value, true);
      expect(decodeUserspaceSyscallTrace(trace)).toMatchObject({
        version: 8, events: [{ wait: { kind: "rseq-slice", deadlineTicks: 12_800n, reason } }],
      });
    }
    for (const [offset, value] of [[128, 0n], [136, 0n], [136, 3n], [192, 1n]] as const) {
      const invalid = trace.slice(); new DataView(invalid.buffer).setBigUint64(24 + offset, value, true);
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    const legacy = trace.slice(); new DataView(legacy.buffer).setUint16(4, 7, true);
    expect(() => decodeUserspaceSyscallTrace(legacy)).toThrow();
    const result = trace.slice(); result[24 + 120] = 0;
    expect(() => decodeUserspaceSyscallTrace(result)).toThrow();
  });
  it("decodes trace v7 kernel CPU waits and rejects unknown models or impossible budgets", () => {
    const trace = new Uint8Array(24 + 288);
    const view = new DataView(trace.buffer);
    trace.set(new TextEncoder().encode("OXLT"));
    view.setUint16(4, 7, true); view.setUint32(8, 288, true); view.setUint32(12, 1, true);
    for (const offset of [24, 32, 40, 56]) view.setBigUint64(offset, 1n, true);
    view.setUint32(48, 1, true); view.setUint32(52, 1, true);
    view.setBigUint64(64, 0x1000n, true); view.setBigUint64(72, 0x1002n, true);
    view.setBigUint64(80, 39n, true); trace[24 + 120] = 2; trace[24 + 122] = 5;
    view.setBigUint64(24 + 128, 1n, true); view.setBigUint64(24 + 136, 1n, true);
    expect(decodeUserspaceSyscallTrace(trace)).toMatchObject({
      version: 7, events: [{ wait: { kind: "kernel-cpu", remainingTicks: 1, model: 1 } }],
    });
    for (const [offset, value] of [[128, 0n], [128, 3n], [136, 0n], [136, 2n]] as const) {
      const invalid = trace.slice();
      new DataView(invalid.buffer).setBigUint64(24 + offset, value, true);
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    const legacy = trace.slice(); new DataView(legacy.buffer).setUint16(4, 6, true);
    expect(() => decodeUserspaceSyscallTrace(legacy)).toThrow();
    const impossible = trace.slice(); impossible[24 + 120] = 0;
    expect(() => decodeUserspaceSyscallTrace(impossible)).toThrow();
  });
  it("validates the engine's deterministic kernel-accounting model", () => {
    expect(decodeUserspaceKernelAccountingModel(1n)).toBe(1);
    for (const value of [0n, 2n, -1n, 1, "1", undefined]) {
      expect(() => decodeUserspaceKernelAccountingModel(value)).toThrow();
    }
  });
  it("uses the admitted registration API", () => {
    expect(USERSPACE_API_VERSION).toBe(143);
  });

  it("distinguishes completed exits from fatal signals without inferring from shell codes", () => {
    expect(decodeUserspaceWaitStatus(0xffff_ffff)).toBeUndefined();
    expect(decodeUserspaceWaitStatus(0)).toEqual({ kind: "exit", code: 0 });
    expect(decodeUserspaceWaitStatus(137 << 8)).toEqual({ kind: "exit", code: 137 });
    expect(decodeUserspaceWaitStatus(9)).toEqual({ kind: "signal", signal: 9 });
    expect(decodeUserspaceWaitStatus(64)).toEqual({ kind: "signal", signal: 64 });
    expect(decodeUserspaceWaitStatus(0x80 | 31)).toEqual({ kind: "signal", signal: 31 });
    for (const value of [-1, 1.5, 65, 0x80, 0x7f, 0x109, 0x10000, "9"]) {
      expect(() => decodeUserspaceWaitStatus(value)).toThrow();
    }
  });

  it("uses the bounded workspace snapshot API", () => {
    expect(USERSPACE_API_VERSION).toBe(143);
  });

  it("decodes the closed pending-work bitmask and rejects reserved bits", () => {
    expect(decodeUserspacePendingWork(0)).toEqual({
      hostRequest: false,
      output: false,
      processExit: false,
      timer: false,
    });
    expect(decodeUserspacePendingWork(0b1111)).toEqual({
      hostRequest: true,
      output: true,
      processExit: true,
      timer: true,
    });
    expect(() => decodeUserspacePendingWork(0b1_0000)).toThrow("reserved bits");
    expect(() => decodeUserspacePendingWork(-1)).toThrow();
  });

  it("encodes bounded arguments and decodes exact termination records", () => {
    const argumentsRecord = encodeUserspaceArguments(["/bin/program", "ok"]);
    expect(new DataView(argumentsRecord.buffer).getUint32(0, true)).toBe(2);
    expect(() => encodeUserspaceArguments(["bad\0argument"])).toThrow("contains NUL");

    const result = new Uint8Array(16);
    result.set(new TextEncoder().encode("OXLR"));
    const view = new DataView(result.buffer);
    view.setUint16(4, 2, true);
    view.setUint32(8, 4, true);
    result[12] = 0;
    result[13] = 37;
    expect(decodeUserspaceRunResult(result)).toEqual({ kind: "exit", code: 37 });
    result[14] = 1;
    expect(() => decodeUserspaceRunResult(result)).toThrow("version is unsupported");
  });

  it("decodes a ranged storage request and refuses ranges outside the file or beyond one transfer", () => {
    const path = new TextEncoder().encode("/usr/local/lib/big");
    const ranged = (offset: bigint, length: bigint, expectedBytes = 10n): Uint8Array => {
      const request = new Uint8Array(92 + path.byteLength);
      request.set(new TextEncoder().encode("OXHR"));
      const view = new DataView(request.buffer);
      view.setUint16(4, 3, true);
      view.setUint32(8, 80 + path.byteLength, true);
      view.setBigUint64(12, 4n, true);
      view.setBigUint64(20, 9n, true);
      view.setBigUint64(28, expectedBytes, true);
      view.setUint32(36, path.byteLength, true);
      request.fill(0xaa, 40, 72);
      view.setBigUint64(76, offset, true);
      view.setBigUint64(84, length, true);
      request.set(path, 92);
      return request;
    };

    expect(decodeUserspaceHostRequest(ranged(3n, 3n))).toEqual({
      kind: "storage",
      generation: 4n,
      id: 9n,
      path: "/usr/local/lib/big",
      expectedBytes: 10,
      expectedSha256: "aa".repeat(32),
      offset: 3,
      length: 3,
    });
    expect(decodeUserspaceHostRequest(ranged(0n, 16n * 1024n * 1024n, 296_865_480n))).toMatchObject({
      expectedBytes: 296_865_480,
      offset: 0,
      length: 16 * 1024 * 1024,
    });
    expect(() => decodeUserspaceHostRequest(ranged(8n, 3n))).toThrow("malformed");
    expect(() => decodeUserspaceHostRequest(ranged(3n, 0n))).toThrow("malformed");
    expect(() => decodeUserspaceHostRequest(ranged(0n, 128n * 1024n * 1024n + 1n, 300n * 1024n * 1024n))).toThrow("malformed");
    const reserved = ranged(3n, 3n);
    reserved[72] = 1;
    expect(() => decodeUserspaceHostRequest(reserved)).toThrow("malformed");
  });

  it("decodes exact host requests and encodes generation-qualified completions", () => {
    const path = new TextEncoder().encode("/lib/libc.so.6");
    const request = new Uint8Array(76 + path.byteLength);
    request.set(new TextEncoder().encode("OXHR"));
    const view = new DataView(request.buffer);
    view.setUint16(4, 2, true);
    view.setUint32(8, 64 + path.byteLength, true);
    view.setBigUint64(12, 4n, true);
    view.setBigUint64(20, 9n, true);
    view.setBigUint64(28, 3n, true);
    view.setUint32(36, path.byteLength, true);
    request.fill(0xaa, 40, 72);
    request.set(path, 76);
    expect(decodeUserspaceHostRequest(request)).toEqual({
      kind: "storage",
      generation: 4n,
      id: 9n,
      path: "/lib/libc.so.6",
      expectedBytes: 3,
      expectedSha256: "aa".repeat(32),
      offset: 0,
      length: 3,
    });

    const completion = encodeUserspaceHostCompletion(4n, 9n, {
      kind: "ok",
      bytes: new Uint8Array([1, 2, 3]),
      sha256: "aa".repeat(32),
    });
    expect(new TextDecoder().decode(completion.subarray(0, 4))).toBe("OXHC");
    expect(new DataView(completion.buffer).getUint16(4, true)).toBe(2);
    expect(new DataView(completion.buffer).getUint32(36, true)).toBe(3);
    expect(completion.slice(40, 72)).toEqual(new Uint8Array(32).fill(0xaa));
    request[72] = 1;
    expect(() => decodeUserspaceHostRequest(request)).toThrow("malformed");
  });

  it("rejects malformed network requests and encodes typed completions", () => {
    const request = new Uint8Array(68);
    request.set(new TextEncoder().encode("OXNR"));
    const view = new DataView(request.buffer);
    view.setUint16(4, 1, true);
    view.setUint32(8, 56, true);
    view.setBigUint64(12, 2n, true);
    view.setBigUint64(20, 3n, true);
    view.setUint8(28, 0);
    view.setBigUint64(32, 7n, true);
    view.setUint32(44, 20, true);
    view.setUint16(48, 2, true);
    view.setUint16(50, 443, false);
    request.set([127, 0, 0, 1], 52);
    expect(decodeUserspaceHostRequest(request)).toMatchObject({
      kind: "network",
      generation: 2n,
      id: 3n,
      operation: { kind: "connect", socket: 7n, family: 2, port: 443 },
    });
    request[29] = 1;
    expect(() => decodeUserspaceHostRequest(request)).toThrow("malformed");

    const completion = encodeUserspaceNetworkHostCompletion(2n, 3n, {
      kind: "received",
      bytes: new Uint8Array([1, 2]),
    });
    expect(new TextDecoder().decode(completion.subarray(0, 4))).toBe("OXNC");
    expect(completion.byteLength).toBe(46);
  });

  it("decodes exact durability requirements and rejects reserved or empty records", () => {
    const request = new Uint8Array(48);
    request.set(new TextEncoder().encode("OXDR"));
    const view = new DataView(request.buffer);
    view.setUint16(4, 1, true);
    view.setUint16(6, 3, true);
    view.setUint32(8, 36, true);
    view.setBigUint64(12, 2n, true);
    view.setBigUint64(20, 7n, true);
    view.setBigUint64(28, 11n, true);
    view.setBigUint64(36, 19n, true);
    expect(decodeUserspaceHostRequest(request)).toEqual({
      kind: "durability", generation: 2n, id: 7n, workspace: 11n, root: 19n,
    });
    for (const [offset, value] of [[4, 2], [6, 0], [6, 4], [8, 35], [12, 0], [20, 0], [44, 1]] as const) {
      const malformed = request.slice(); malformed[offset] = value;
      expect(() => decodeUserspaceHostRequest(malformed)).toThrow("malformed");
    }
    view.setUint16(6, 1, true);
    expect(() => decodeUserspaceHostRequest(request)).toThrow("malformed");
    view.setBigUint64(36, 0n, true);
    expect(decodeUserspaceHostRequest(request)).toEqual({ kind: "durability", generation: 2n, id: 7n, workspace: 11n });
    view.setBigUint64(28, 0xffff_ffff_ffff_ffffn, true);
    expect(() => decodeUserspaceHostRequest(request)).toThrow("malformed");
    const completion = encodeUserspaceDurabilityHostCompletion(2n, 7n, { kind: "error", errno: 28 });
    const result = new DataView(completion.buffer);
    expect(completion.byteLength).toBe(32);
    expect(result.getBigUint64(12, true)).toBe(2n);
    expect(result.getBigUint64(20, true)).toBe(7n);
    expect(result.getUint32(28, true)).toBe(28);
    expect(() => encodeUserspaceDurabilityHostCompletion(0n, 7n, { kind: "ok" })).toThrow("malformed");
  });

  it("preserves durability wait identity in v5 and rejects its tag in older traces", () => {
    const trace = futexTraceV4(128, null, 0), view = new DataView(trace.buffer);
    trace.fill(0, 24 + 192); view.setUint16(4, 5, true);
    view.setUint8(24 + 122, 4); view.setBigUint64(24 + 128, 2n, true); view.setBigUint64(24 + 136, 9n, true);
    expect(decodeUserspaceSyscallTrace(trace)).toMatchObject({ version: 5, events: [{ wait: { kind: "durability", generation: 2n, id: 9n } }] });
    view.setUint16(4, 4, true);
    expect(() => decodeUserspaceSyscallTrace(trace)).toThrow("malformed");
  });

  it("retains exact seccomp decision origins in v6 and validates their closed layout", () => {
    const trace = new Uint8Array(24 + 288);
    trace.set(futexTraceV4(128, null, 0));
    trace.fill(0, 24 + 122);
    trace[24 + 121] = 0;
    const view = new DataView(trace.buffer), offset = 24 + 272;
    view.setUint16(4, 6, true);
    view.setUint32(8, 288, true);
    view.setUint8(offset, 3);
    view.setUint16(offset + 2, 1289, true);
    view.setUint32(offset + 4, 0x50001, true);
    view.setBigUint64(offset + 8, 7n, true);
    expect(decodeUserspaceSyscallTrace(trace)).toMatchObject({ version: 6, events: [{ seccomp: { kind: "filter", programId: 7n, instruction: 1289, value: 0x50001, flags: 0 } }] });
    for (const flags of [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]) {
      view.setUint8(offset + 1, flags);
      expect(decodeUserspaceSyscallTrace(trace).events[0]?.seccomp).toMatchObject({ kind: "filter", flags });
    }
    view.setUint8(offset + 1, 0);
    for (const [position, value] of [[0, 4], [1, 0x80]] as const) {
      const malformed = trace.slice(); malformed[offset + position] = value;
      expect(() => decodeUserspaceSyscallTrace(malformed)).toThrow("malformed");
    }
    view.setBigUint64(offset + 8, 0n, true);
    expect(() => decodeUserspaceSyscallTrace(trace)).toThrow("malformed");
    view.setUint8(offset, 1); trace.fill(0, offset + 2);
    expect(decodeUserspaceSyscallTrace(trace).events[0]?.seccomp).toEqual({ kind: "strict", action: "allow" });
    view.setUint8(offset, 2);
    expect(decodeUserspaceSyscallTrace(trace).events[0]?.seccomp).toEqual({ kind: "strict", action: "kill" });
    view.setUint32(offset + 4, 1, true);
    expect(() => decodeUserspaceSyscallTrace(trace)).toThrow("malformed");
    trace.fill(0, offset);
    expect(decodeUserspaceSyscallTrace(trace).events[0]).not.toHaveProperty("seccomp");
  });

  it("decodes bounded redacted syscall traces with exact identity", () => {
    const trace = syscallTrace();
    expect(decodeUserspaceSyscallTrace(trace)).toEqual({
      version: 1,
      dropped: 2n,
      events: [{
        kind: "syscall",
        sequence: 7n,
        correlation: 6n,
        runtimeGeneration: 1n,
        pid: 3,
        tid: 4,
        addressSpace: 5n,
        instructionRip: 0x1000n,
        nextRip: 0x1002n,
        number: 1n,
        name: "write",
        arguments: [1n, 2n, 3n, 4n, 5n, 6n],
        outcome: { kind: "result", value: -38n },
      }],
    });
    trace[146] = 1;
    expect(() => decodeUserspaceSyscallTrace(trace)).toThrow("malformed");
  });

  it("decodes the exact v2 host wait identity", () => {
    const trace = new Uint8Array(24 + 192);
    const view = new DataView(trace.buffer);
    trace.set(new TextEncoder().encode("OXLT"));
    view.setUint16(4, 2, true);
    view.setUint32(8, 192, true);
    view.setUint32(12, 1, true);
    view.setBigUint64(24, 1n, true);
    view.setBigUint64(32, 1n, true);
    view.setBigUint64(40, 1n, true);
    view.setUint32(48, 1, true);
    view.setUint32(52, 1, true);
    view.setBigUint64(56, 1n, true);
    view.setBigUint64(80, 17n, true);
    view.setUint8(24 + 120, 2);
    view.setUint8(24 + 122, 1);
    view.setBigUint64(24 + 128, 4n, true);
    view.setBigUint64(24 + 136, 9n, true);
    trace.set(new TextEncoder().encode("pread64"), 24 + 152);
    view.setUint8(24 + 121, 7);

    expect(decodeUserspaceSyscallTrace(trace).events[0]).toMatchObject({
      outcome: { kind: "blocked" },
      wait: { kind: "storage", generation: 4n, id: 9n },
    });
  });

  it("decodes generation-qualified v3 futex wake transitions and rejects reserved bytes", () => {
    const trace = new Uint8Array(24 + 272);
    const view = new DataView(trace.buffer);
    trace.set(new TextEncoder().encode("OXLT"));
    view.setUint16(4, 3, true);
    view.setUint32(8, 272, true);
    view.setUint32(12, 1, true);
    view.setBigUint64(24, 2n, true);
    view.setBigUint64(32, 1n, true);
    view.setBigUint64(40, 1n, true);
    view.setUint32(48, 7, true);
    view.setUint32(52, 8, true);
    view.setBigUint64(56, 9n, true);
    view.setBigUint64(80, 202n, true);
    view.setBigUint64(88, 0x2000n, true);
    view.setBigUint64(96, 128n, true);
    view.setBigUint64(104, 7n, true);
    view.setUint8(24 + 122, 3);
    trace.set(new TextEncoder().encode("futex"), 24 + 152);
    view.setUint8(24 + 121, 5);
    view.setBigUint64(24 + 192, 0x2000n, true);
    view.setBigUint64(24 + 200, 10_000n, true);
    view.setBigUint64(24 + 208, 12n, true);
    view.setBigUint64(24 + 216, 13n, true);
    view.setUint32(24 + 224, 128, true);
    view.setUint32(24 + 228, 7, true);
    view.setUint32(24 + 232, 7, true);
    view.setUint32(24 + 236, 7, true);
    view.setUint32(24 + 240, 9, true);
    view.setUint8(24 + 244, 3);
    view.setUint8(24 + 245, 2);
    view.setUint8(24 + 246, 1);

    expect(decodeUserspaceSyscallTrace(trace)).toMatchObject({
      version: 3,
      events: [{
        wait: {
          kind: "futex",
          address: 0x2000n,
          private: true,
          waiterGeneration: 12n,
          timerGeneration: 13n,
          wakeOwner: { pid: 7, tid: 9 },
          reason: "wake",
          transition: "blocked-to-runnable",
          deadline: 10_000n,
          deadlineClock: "monotonic",
        },
      }],
    });

    trace[24 + 247] = 1;
    expect(() => decodeUserspaceSyscallTrace(trace)).toThrow("malformed");
    trace[24 + 247] = 0;
    trace[24 + 271] = 1;
    expect(() => decodeUserspaceSyscallTrace(trace)).toThrow("malformed");
  });

  it("decodes the v4 futex deadline clock and rejects one that contradicts the operation", () => {
    const realtimeBitset = 9 | 128 | 256;
    const trace = futexTraceV4(realtimeBitset, 1_700_000_000_000_000_000n, 2);
    expect(decodeUserspaceSyscallTrace(trace)).toMatchObject({
      version: 4,
      events: [{
        wait: {
          kind: "futex",
          operation: realtimeBitset,
          deadline: 1_700_000_000_000_000_000n,
          deadlineClock: "realtime",
          reason: "parked",
          transition: "running-to-blocked",
        },
      }],
    });
    expect(decodeUserspaceSyscallTrace(futexTraceV4(128, 5_000_000n, 1)).events[0]?.wait)
      .toMatchObject({ deadline: 5_000_000n, deadlineClock: "monotonic" });
    expect(decodeUserspaceSyscallTrace(futexTraceV4(128, null, 0)).events[0]?.wait)
      .toMatchObject({ deadline: null, deadlineClock: null });

    expect(() => decodeUserspaceSyscallTrace(futexTraceV4(realtimeBitset, 5n, 1))).toThrow("malformed");
    expect(() => decodeUserspaceSyscallTrace(futexTraceV4(128, 5n, 2))).toThrow("malformed");
    expect(() => decodeUserspaceSyscallTrace(futexTraceV4(128, 5n, 0))).toThrow("malformed");
    expect(() => decodeUserspaceSyscallTrace(futexTraceV4(128, null, 1))).toThrow("malformed");
    expect(() => decodeUserspaceSyscallTrace(futexTraceV4(128, 5n, 3))).toThrow("malformed");
    const reserved = futexTraceV4(128, 5n, 1);
    reserved[24 + 248] = 1;
    expect(() => decodeUserspaceSyscallTrace(reserved)).toThrow("malformed");
  });
});

/** A v4 trace holding one parked futex wait with the given deadline and clock byte. */
function futexTraceV4(operation: number, deadline: bigint | null, clock: number): Uint8Array {
  const trace = new Uint8Array(24 + 272);
  const view = new DataView(trace.buffer);
  trace.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 4, true);
  view.setUint32(8, 272, true);
  view.setUint32(12, 1, true);
  view.setBigUint64(24, 2n, true);
  view.setBigUint64(32, 2n, true);
  view.setBigUint64(40, 1n, true);
  view.setUint32(48, 7, true);
  view.setUint32(52, 8, true);
  view.setBigUint64(56, 9n, true);
  view.setBigUint64(80, 202n, true);
  view.setBigUint64(88, 0x2000n, true);
  view.setBigUint64(96, BigInt(operation), true);
  view.setUint8(24 + 120, 2);
  view.setUint8(24 + 122, 3);
  trace.set(new TextEncoder().encode("futex"), 24 + 152);
  view.setUint8(24 + 121, 5);
  view.setBigUint64(24 + 192, 0x2000n, true);
  view.setBigUint64(24 + 200, deadline ?? 0xffff_ffff_ffff_ffffn, true);
  view.setBigUint64(24 + 208, 12n, true);
  view.setBigUint64(24 + 216, deadline === null ? 0n : 13n, true);
  view.setUint32(24 + 224, operation, true);
  view.setUint8(24 + 244, 2);
  view.setUint8(24 + 245, 1);
  view.setUint8(24 + 246, 1);
  view.setUint8(24 + 247, clock);
  return trace;
}

function syscallTrace(): Uint8Array {
  const trace = new Uint8Array(184);
  const view = new DataView(trace.buffer);
  trace.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 1, true);
  view.setUint32(8, 160, true);
  view.setUint32(12, 1, true);
  view.setBigUint64(16, 2n, true);
  view.setBigUint64(24, 7n, true);
  view.setBigUint64(32, 6n, true);
  view.setBigUint64(40, 1n, true);
  view.setUint32(48, 3, true);
  view.setUint32(52, 4, true);
  view.setBigUint64(56, 5n, true);
  view.setBigUint64(64, 0x1000n, true);
  view.setBigUint64(72, 0x1002n, true);
  view.setBigUint64(80, 1n, true);
  for (let argument = 0; argument < 6; argument += 1) {
    view.setBigUint64(88 + argument * 8, BigInt(argument + 1), true);
  }
  view.setBigInt64(136, -38n, true);
  trace[145] = 5;
  trace.set(new TextEncoder().encode("write"), 152);
  return trace;
}

it("decodes accepted stdin prefixes and bounded Linux errors", () => {
  expect(decodeUserspaceStdinCount(1, 2)).toBe(1);
  expect(decodeUserspaceStdinCount(-11, 2)).toBe(0);
  expect(() => decodeUserspaceStdinCount(-32, 2)).toThrow("errno 32");
  for (const invalid of [3, -4096, 0.5, Number.NaN, "1"]) expect(() => decodeUserspaceStdinCount(invalid, 2)).toThrow();
});

it("decodes versioned JS launches and refuses stale or malformed identity", () => {
  for (const store of [".bun", ".pnpm"]) {
    const entry = `/workspace/node_modules/${store}/typescript@6.0.2/node_modules/typescript/bin/tsc`;
    const bytes = new Writer().raw(new TextEncoder().encode("OXCR")).u32(17).u64(2n).u64(5n).u32(7).u8(1).path("/workspace").u8(0).path(entry).path("/usr/local/bin/bun").strings(["--noEmit"]).strings(["TERM=dumb"]).finish();
    expect(decodeUserspaceHostRequest(bytes)).toEqual({ kind: "command", generation: 2n, id: 5n, pid: 7, tty: true, cwd: "/workspace", program: { kind: "typescript", entry, executable: "/usr/local/bin/bun" }, args: ["--noEmit"], environment: ["TERM=dumb"] });
    const view = new DataView(bytes.buffer); view.setBigUint64(16, 0n, true); expect(() => decodeUserspaceHostRequest(bytes)).toThrow();
    view.setBigUint64(16, 5n, true); view.setUint32(4, 1, true); expect(() => decodeUserspaceHostRequest(bytes)).toThrow();
  }
});


it("rejects JS compiler launches outside the two qualified placements", () => {
  for (const entry of ["/tmp/tsc", "/workspace/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc"]) {
    const bytes = new Writer().raw(new TextEncoder().encode("OXCR")).u32(17).u64(2n).u64(5n).u32(7).u8(1).path("/workspace").u8(0).path(entry).path("/usr/bin/node").strings(["--noEmit"]).strings([]).finish();
    expect(() => decodeUserspaceHostRequest(bytes)).toThrow("Unqualified TypeScript process");
  }
});
