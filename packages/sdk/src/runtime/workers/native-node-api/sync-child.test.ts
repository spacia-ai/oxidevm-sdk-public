import { expect, it } from "vitest";
import { LinuxError, type LinuxOperation, type LinuxResult, Reader, Writer } from "../../js-process/codec.js";
import { captureNativeChild } from "./sync-child.js";
import { VMError } from "../../errors.js";

function transport(fail = false, status = 0, output?: Uint8Array[], stderrFirst = false) {
  const closed: number[] = [], signals: number[] = [], input: number[] = [], reads = new Map([[4, output ?? [Uint8Array.of(65, 66), new Uint8Array()]], [5, [stderrFirst ? Uint8Array.of(67, 68) : Uint8Array.of(67), new Uint8Array()]]]);
  let waits = 0, firstWrite = true;
  return { closed, signals, input, waits: () => waits, sync<T>(request: LinuxOperation<T>): T {
    const reader = new Reader(request.payload); let result: LinuxResult = { value: 0n, bytes: new Uint8Array() };
    switch (request.number) {
      case 65538: result = { value: 9n, bytes: new Writer().u32(3).u32(4).u32(5).finish() }; break;
      case 72: reader.u64(); result = { ...result, value: reader.u32() === 3 ? 1n : 0n }; break;
      case 7: case 65549: {
        const count = reader.u32(), bytes = new Uint8Array(count * 8), view = new DataView(bytes.buffer);
        for (let index = 0; index < count; index++) {
          const fd = Number(reader.u64()), events = reader.u32();
          expect(closed).not.toContain(fd);
          view.setInt32(index * 8, fd, true); view.setUint16(index * 8 + 4, events, true); view.setUint16(index * 8 + 6, events, true);
        }
        const ordered = stderrFirst ? new Uint8Array(count * 8) : bytes;
        if (stderrFirst) for (let index = 0; index < count; index++) ordered.set(bytes.subarray(index * 8, index * 8 + 8), (count - 1 - index) * 8);
        result = { value: BigInt(count), bytes: ordered }; break;
      }
      case 1: {
        reader.u64(); const bytes = reader.blob();
        if (firstWrite) { firstWrite = false; throw new LinuxError(11); }
        input.push(...bytes.subarray(0, 1)); result = { ...result, value: 1n }; break;
      }
      case 0: {
        if (fail) throw new LinuxError(5);
        const fd = Number(reader.u64()), bytes = reads.get(fd)?.shift();
        if (bytes === undefined) throw new Error("Read after EOF");
        result = { value: BigInt(bytes.byteLength), bytes }; break;
      }
      case 3: closed.push(Number(reader.u64())); break;
      case 62: expect(reader.u32()).toBe(9); signals.push(reader.u8()); break;
      case 61: expect(reader.u32()).toBe(9); waits++; result = { ...result, value: BigInt(status) }; break;
      default: throw new Error(`Unexpected child operation ${String(request.number)}`);
    }
    return request.decode(result);
  } };
}
const launch = { kind: "spawn", command: "/bin/tool", args: [], cwd: "/workspace", env: {} } as const;

it("captures both pipes while preserving short input writes and EAGAIN", () => {
  const client = transport(), result = captureNativeChild(client, launch, Uint8Array.of(1, 2, 3), 16);
  expect(result).toEqual({ pid: 9, status: 0, signal: null, stdout: Uint8Array.of(65, 66), stderr: Uint8Array.of(67) });
  expect(client.input).toEqual([1, 2, 3]); expect(client.closed.sort()).toEqual([3, 4, 5]); expect(client.waits()).toBe(1);
});

it("kills and reaps the native child and closes every pipe after capture failure", () => {
  const client = transport(true);
  expect(() => captureNativeChild(client, launch, Uint8Array.of(1), 16)).toThrow(LinuxError);
  expect(client.closed.sort()).toEqual([3, 4, 5]); expect(client.signals).toEqual([9]); expect(client.waits()).toBe(1);
});

it("keeps Node's overflowing read and closes all pipes before reading the other stream", () => {
  const client = transport(false, 15), result = captureNativeChild(client, launch, new Uint8Array(), 1);
  expect(result).toMatchObject({ error: "ENOBUFS", status: null, signal: 15, stdout: Uint8Array.of(65, 66), stderr: new Uint8Array() });
  expect(client.signals).toEqual([15]); expect(client.waits()).toBe(1); expect(client.closed.sort()).toEqual([3, 4, 5]);
});

it("counts Node's combined stdout and stderr before killing and reaping", () => {
  const client = transport(false, 15), result = captureNativeChild(client, launch, new Uint8Array(), 2);
  expect(result).toMatchObject({ error: "ENOBUFS", stdout: Uint8Array.of(65, 66), stderr: Uint8Array.of(67) });
  expect(client.signals).toEqual([15]); expect(client.waits()).toBe(1); expect(client.closed.sort()).toEqual([3, 4, 5]);
});

it("uses Rust's first-ready pipe identity when stderr overflows before stdout", () => {
  const client = transport(false, 15, undefined, true), result = captureNativeChild(client, launch, new Uint8Array(), 1);
  expect(result).toMatchObject({ error: "ENOBUFS", stdout: new Uint8Array(), stderr: Uint8Array.of(67, 68), signal: 15 });
  expect(client.signals).toEqual([15]); expect(client.closed.sort()).toEqual([3, 4, 5]); expect(client.waits()).toBe(1);
});

it("uses Bun's per-stream limit and drains both streams after overflow", () => {
  const ordinary = transport(), result = captureNativeChild(ordinary, launch, new Uint8Array(), 2, { runtime: "bun" });
  expect(result).toMatchObject({ status: 0, stdout: Uint8Array.of(65, 66), stderr: Uint8Array.of(67) });
  expect(result.error).toBeUndefined(); expect(ordinary.signals).toEqual([]);
  const overflow = transport(false, 15), failed = captureNativeChild(overflow, launch, new Uint8Array(), 1, { runtime: "bun" });
  expect(failed).toMatchObject({ error: "ENOBUFS", status: null, signal: 15, stdout: Uint8Array.of(65, 66), stderr: Uint8Array.of(67) });
  expect(overflow.signals).toEqual([15]); expect(overflow.waits()).toBe(1); expect(overflow.closed.sort()).toEqual([3, 4, 5]);
});

it("fails explicitly and releases every resource when Bun overflow spill exhausts capture memory", () => {
  const chunk = new Uint8Array(65536), client = transport(false, 15, Array.from({ length: 1026 }, () => chunk));
  let failure: unknown;
  try { captureNativeChild(client, launch, new Uint8Array(), 1, { runtime: "bun" }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(VMError); expect(failure).toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(client.closed.sort()).toEqual([3, 4, 5]); expect(client.signals).toEqual([15, 9]); expect(client.waits()).toBe(1);
});
