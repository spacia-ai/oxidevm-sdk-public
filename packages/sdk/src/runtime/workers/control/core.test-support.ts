import { JIT_API_VERSION } from "../../core-abi/jit.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { CORE_API_VERSION, createCore } from "./core.js";

export interface CoreCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/**
 * A core whose exports record their calls and succeed, except `oxidevm_system_restore_validate`,
 * which returns `validateStatus`. `memoryPages` sizes the staging memory (64 KiB pages).
 */
export function recordingCore(validateStatus = 0, memoryPages = 2) {
  const memory = new WebAssembly.Memory({ initial: memoryPages });
  const calls: CoreCall[] = [];
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_system_restore_validate: (...args: unknown[]) => {
      calls.push({ name: "oxidevm_system_restore_validate", args });
      return validateStatus;
    },
    oxidevm_system_restore_finish: (...args: unknown[]) => {
      calls.push({ name: "oxidevm_system_restore_finish", args });
      return 0;
    },
  };
  const core = createCore(new Proxy(functions, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return target[key] ?? ((...args: unknown[]) => {
        calls.push({ name: key, args });
        return 0;
      });
    },
  }), memory, "snapshot-test", JIT_CACHE_BYTES);
  return { core, calls };
}

const MIB = 1024 * 1024;
const RESULT = 2 * MIB;

/**
 * A core whose RAM tracks dirty chunks. A chunk's bytes are its guest write count plus one, and
 * `write` makes the guest write a chunk, which also makes it dirty again.
 */
export function dirtyCore(dirty: Iterable<number>) {
  const memory = new WebAssembly.Memory({ initial: 64 });
  const state = {
    dirty: new Set(dirty),
    writes: new Map<number, number>(),
    calls: [] as string[],
    commits: [] as number[][],
    marks: [] as number[][],
  };
  let resultLength = 0;
  const result = (bytes: Uint8Array): number => {
    new Uint8Array(memory.buffer, RESULT, bytes.byteLength).set(bytes);
    resultLength = bytes.byteLength;
    return 0;
  };
  const staged = (count: number): number[] => {
    const view = new DataView(memory.buffer, 0, count * 8);
    return Array.from({ length: count }, (_, index) => Number(view.getBigUint64(index * 8, true)));
  };
  const indices = (chunks: Iterable<number>): Uint8Array => {
    const list = [...chunks].sort((left, right) => left - right);
    const bytes = new Uint8Array(list.length * 8);
    list.forEach((chunk, index) => new DataView(bytes.buffer).setBigUint64(index * 8, BigInt(chunk), true));
    return bytes;
  };
  const functions: Record<string, unknown> = {
    oxidevm_api_version: () => CORE_API_VERSION,
    oxidevm_jit_api_version: () => JIT_API_VERSION,
    oxidevm_staging_ptr: () => 0,
    oxidevm_staging_resize: () => 0,
    oxidevm_result_ptr: () => RESULT,
    oxidevm_result_len: () => resultLength,
    oxidevm_system_snapshot: () => {
      state.calls.push("record");
      return result(new Uint8Array([0x4f, 0x58, 0x4d, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]));
    },
    oxidevm_system_dirty_ram_chunks: () => result(indices(state.dirty)),
    oxidevm_system_dirty_disk_chunks: () => result(new Uint8Array(16)),
    oxidevm_system_read_ram_chunk: (chunk: number) => {
      state.calls.push(`read ${String(chunk)}`);
      return result(new Uint8Array(MIB).fill((state.writes.get(chunk) ?? 0) + 1));
    },
    oxidevm_system_snapshot_commit_ram: (count: number) => {
      const chunks = staged(count);
      state.calls.push(`clear ${chunks.join(",")}`);
      state.commits.push(chunks);
      for (const chunk of chunks) state.dirty.delete(chunk);
      return 0;
    },
    oxidevm_system_mark_ram_dirty: (count: number) => {
      const chunks = staged(count);
      state.marks.push(chunks);
      for (const chunk of chunks) state.dirty.add(chunk);
      return 0;
    },
  };
  const core = createCore(new Proxy(functions, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      return target[key] ?? (() => 0);
    },
  }), memory, "capture-test", JIT_CACHE_BYTES);
  const write = (chunk: number): void => {
    state.writes.set(chunk, (state.writes.get(chunk) ?? 0) + 1);
    state.dirty.add(chunk);
  };
  return { core, state, write };
}
