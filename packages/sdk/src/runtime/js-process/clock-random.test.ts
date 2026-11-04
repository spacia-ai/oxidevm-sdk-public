import { expect, it } from "vitest";
import { VMError } from "../errors.js";
import { clockHost, clockOperations, RANDOM_CHUNK_BYTES, randomHost, randomOperation } from "./clock-random.js";
import { Reader, type LinuxOperation, type LinuxResult } from "./codec.js";

const empty = (value = 0n): LinuxResult => ({ value, bytes: new Uint8Array() });
function thrown(action: () => unknown): unknown { try { action(); } catch (error: unknown) { return error; } return undefined; }

it("reads the VM's realtime and monotonic clocks by their Linux ids", () => {
  expect([clockOperations.now("realtime").number, Array.from(clockOperations.now("realtime").payload)]).toEqual([228, [0, 0, 0, 0]]);
  expect([clockOperations.now("monotonic").number, Array.from(clockOperations.now("monotonic").payload)]).toEqual([228, [1, 0, 0, 0]]);
  expect([clockOperations.resolution("monotonic").number, Array.from(clockOperations.resolution("monotonic").payload)]).toEqual([229, [1, 0, 0, 0]]);
  expect(clockOperations.now("realtime").decode(empty(2n ** 64n - 1n))).toBe(2n ** 64n - 1n);
  expect(() => clockOperations.now("monotonic").decode({ value: 1n, bytes: new Uint8Array(1) })).toThrow(VMError);
  expect(clockOperations.resolution("realtime").decode(empty(1n))).toBe(1n);
  expect(() => clockOperations.resolution("realtime").decode(empty())).toThrow(VMError);
  const other: unknown = "boottime";
  expect(thrown(() => Reflect.apply(clockOperations.now, undefined, [other]))).toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("asks getrandom for exactly the bytes it needs and refuses a short, long or mislabelled answer", () => {
  const request = randomOperation(4);
  expect([request.number, Array.from(request.payload)]).toEqual([318, [4, 0, 0, 0, 0, 0, 0, 0]]);
  expect(Array.from(request.decode({ value: 4n, bytes: Uint8Array.of(9, 8, 7, 6) }))).toEqual([9, 8, 7, 6]);
  for (const bad of [{ value: 3n, bytes: Uint8Array.of(9, 8, 7) }, { value: 4n, bytes: Uint8Array.of(9, 8, 7) }, { value: 5n, bytes: new Uint8Array(5) }]) expect(() => request.decode(bad)).toThrow(VMError);
  expect(() => randomOperation(0)).not.toThrow();
  for (const count of [-1, RANDOM_CHUNK_BYTES + 1, 1.5]) expect(thrown(() => randomOperation(count))).toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("fills any length from bounded chunks, in order, and reads the clocks synchronously", () => {
  const asked: number[] = [];
  let next = 0;
  const client = {
    sync<T>(operation: LinuxOperation<T>): T {
      const reader = new Reader(operation.payload);
      if (operation.number === 228) return operation.decode(empty(BigInt(reader.u32()) + 41n));
      const count = reader.u32(); asked.push(count);
      return operation.decode({ value: BigInt(count), bytes: Uint8Array.from({ length: count }, () => next++ & 0xff) });
    },
  };
  const bytes = new Uint8Array(RANDOM_CHUNK_BYTES * 2 + 3);
  randomHost(client).fill(bytes);
  expect(asked).toEqual([RANDOM_CHUNK_BYTES, RANDOM_CHUNK_BYTES, 3]);
  expect(bytes.every((byte, index) => byte === (index & 0xff))).toBe(true);
  randomHost(client).fill(new Uint8Array());
  expect(asked).toHaveLength(3);
  expect(clockHost(client).now("monotonic")).toBe(42n);
});
