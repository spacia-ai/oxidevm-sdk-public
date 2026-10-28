import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { readUserspaceListeners } from "./userspace-listener-read.js";

const RECORD = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0);

/** A runtime whose listener exports answer from fixed values and record what was called. */
function fakeRuntime(generation: bigint, options: { readonly pointer?: number; readonly status?: number } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const pointer = options.pointer ?? 1024;
  if (pointer + RECORD.byteLength <= memory.buffer.byteLength) new Uint8Array(memory.buffer, pointer, RECORD.byteLength).set(RECORD);
  const calls: string[] = [];
  const exports: WebAssembly.Exports = {
    oxidevm_userspace_listener_generation: () => { calls.push("generation"); return generation; },
    oxidevm_userspace_listeners: () => { calls.push("listeners"); return options.status ?? 0; },
    oxidevm_userspace_listeners_ptr: () => pointer,
    oxidevm_userspace_listeners_len: () => RECORD.byteLength,
  };
  return { runtime: { instance: { exports }, memory }, calls };
}

describe("readUserspaceListeners", () => {
  it("answers none before any process exists", () => {
    expect(readUserspaceListeners(undefined, null)).toEqual({ kind: "none" });
  });

  it("rereads the list only when the generation moved", () => {
    const { runtime, calls } = fakeRuntime(4n);
    expect(readUserspaceListeners(runtime, 4n)).toEqual({ kind: "unchanged", generation: 4n });
    expect(calls).toEqual(["generation"]);
  });

  it("copies the record out of memory when the generation moved", () => {
    const { runtime, calls } = fakeRuntime(4n);
    const read = readUserspaceListeners(runtime, 3n);
    expect(read).toEqual({ kind: "listeners", record: RECORD });
    expect(calls).toEqual(["generation", "listeners"]);
    if (read.kind !== "listeners") throw new Error("no record");
    expect(read.record.buffer).not.toBe(runtime.memory.buffer);
  });

  it("reads the list when the caller knows no generation", () => {
    expect(readUserspaceListeners(fakeRuntime(0n).runtime, null)).toMatchObject({ kind: "listeners" });
  });

  it.each([
    ["an unreadable generation", fakeRuntime(-1n)],
    ["a failed encoding", fakeRuntime(5n, { status: 2 })],
    ["a record outside memory", fakeRuntime(5n, { pointer: 65_530 })],
  ])("fails on %s", (_name, { runtime }) => {
    let code: unknown;
    try { readUserspaceListeners(runtime, 4n); } catch (error) { code = error instanceof VMError ? error.code : error; }
    expect(["GUEST_CRASH", "PROTOCOL_ERROR"]).toContain(code);
  });
});
