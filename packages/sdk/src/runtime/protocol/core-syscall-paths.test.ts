import { describe, expect, it } from "vitest";
import { CORE_SYSCALL_PATH_KEYS, CORE_SYSCALL_PATH_KEYS_V32, decodeSyscallPaths, syscallPathsFromValues } from "./core-syscall-paths.js";

describe("syscall path counters", () => {
  it("names the 23 fields of record 33 in wire order, the 22 of record 32 first", () => {
    const counters = syscallPathsFromValues(CORE_SYSCALL_PATH_KEYS.map((_, index) => index === 0 ? 10n : BigInt(index)));
    expect(Object.keys(counters)).toEqual(CORE_SYSCALL_PATH_KEYS);
    expect(CORE_SYSCALL_PATH_KEYS).toHaveLength(23);
    expect(CORE_SYSCALL_PATH_KEYS.slice(0, 22)).toEqual(CORE_SYSCALL_PATH_KEYS_V32);
    expect(counters.jitInBlockSyscallContinues).toBe(1n);
    expect(counters.jitInBlockSyscallStopDispatchNotReady).toBe(4n);
    expect(counters.jitDirectSyscallSteps).toBe(5n);
    expect(counters.plainSyscallsQuiet).toBe(6n);
    expect(counters.plainSyscallsCompleted).toBe(7n);
    expect(counters.plainSyscallDeclinedNotInTable).toBe(8n);
    expect(counters.plainSyscallDeclinedFrozen).toBe(21n);
    expect(counters.plainSyscallDeclinedFileSizeLimit).toBe(22n);
  });

  it("requires in-block requests to equal continues plus stops", () => {
    const values = Array<bigint>(23).fill(0n);
    values[0] = 5n;
    values[1] = 3n;
    values[2] = 1n;
    values[4] = 1n;
    const counters = syscallPathsFromValues(values);
    expect(decodeSyscallPaths(counters, 56)).toEqual(counters);
    expect(() => decodeSyscallPaths({ ...counters, jitInBlockSyscalls: 6n }, 56)).toThrow("reconcile");
  });

  it("is empty before trace schema 55 and rejects counts there", () => {
    expect(decodeSyscallPaths({}, 54)).toEqual(syscallPathsFromValues([]));
    expect(() => decodeSyscallPaths({ plainSyscallsQuiet: 1n }, 54)).toThrow("historical");
  });

  it("reads trace schema 55 without the file size limit count and rejects one there", () => {
    const values = Array<bigint>(22).fill(0n);
    values[6] = 4n;
    values[21] = 2n;
    const schema55 = Object.fromEntries(Object.entries(syscallPathsFromValues(values)).filter(([key]) => key !== "plainSyscallDeclinedFileSizeLimit"));
    expect(decodeSyscallPaths(schema55, 55)).toEqual(syscallPathsFromValues(values));
    expect(() => decodeSyscallPaths({ ...schema55, plainSyscallDeclinedFileSizeLimit: 1n }, 55)).toThrow("historical");
    expect(decodeSyscallPaths({ ...schema55, plainSyscallDeclinedFileSizeLimit: 3n }, 56).plainSyscallDeclinedFileSizeLimit).toBe(3n);
    expect(() => decodeSyscallPaths(schema55, 56)).toThrow();
  });
});
