import { expect, it } from "vitest";
import { admitInitialUserspaceProcess } from "./userspace-process-admission.js";
import { decodeUserspaceSpawnResult } from "../userspace-abi.js";

function result(pid: number, errno: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  view.setUint32(0, pid, true); view.setUint32(4, errno, true);
  return bytes;
}

function runtime(responses: readonly (Uint8Array | "pending" | "boundary-error")[]) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const sources: Uint8Array[] = [];
  let index = 0, rawCalls = 0;
  const instance: WebAssembly.Instance = { exports: {
    oxidevm_userspace_staging_resize: () => 0,
    oxidevm_userspace_staging_ptr: () => 64,
    oxidevm_userspace_file_record_len: () => 8,
    oxidevm_userspace_spawn_top_level_executable: (length: number) => {
      sources.push(new Uint8Array(memory.buffer, 64, length).slice());
      const response = responses[index++];
      if (response === undefined) throw new Error("unexpected admission retry");
      if (response === "pending") return 3;
      if (response === "boundary-error") return 2;
      new Uint8Array(memory.buffer, 64, response.byteLength).set(response);
      return 0;
    },
    oxidevm_userspace_spawn_top_level_process: () => { rawCalls += 1; return 7; },
  } };
  return { memory, instance, sources, rawCalls: () => rawCalls };
}

const input = { arguments: ["/usr/bin/node", "/workspace/main.cjs"], environment: [], cwd: "/workspace" };

it("decodes exact exclusive PID and errno records, including a subview", () => {
  const bytes = new Uint8Array(24); bytes.set(result(7, 0), 8);
  expect(decodeUserspaceSpawnResult(bytes.subarray(8, 16))).toEqual({ kind: "spawned", pid: 7 });
  expect(decodeUserspaceSpawnResult(result(0, 13))).toEqual({ kind: "error", errno: 13 });
  for (const invalid of [new Uint8Array(7), new Uint8Array(9), result(0, 0), result(1, 13), result(0x8000_0000, 0), result(0, 4096)]) {
    expect(() => decodeUserspaceSpawnResult(invalid)).toThrow("Userspace spawn result has an invalid");
  }
});

it("keeps filename authority across host reads and memory growth", async () => {
  const target = runtime(["pending", result(9, 0)]);
  let reads = 0;
  const pid = await admitInitialUserspaceProcess(target, { kind: "file", filename: "/bin/alias" }, input, () => {}, () => {
    reads += 1; target.memory.grow(1); return Promise.resolve(true);
  });
  expect(pid).toBe(9); expect(reads).toBe(1); expect(target.rawCalls()).toBe(0);
  expect(target.sources.map(bytes => new TextDecoder().decode(bytes))).toEqual(["/bin/alias", "/bin/alias"]);
});

it("preserves raw ELF authority even when argv names a runtime", async () => {
  const target = runtime([]);
  expect(await admitInitialUserspaceProcess(target, { kind: "elf", bytes: new Uint8Array([127, 69, 76, 70]) }, input, () => {}, () => Promise.resolve(false))).toBe(7);
  expect(target.rawCalls()).toBe(1); expect(target.sources).toEqual([]);
});

it("cancels after a backing read before any second admission or PID publication", async () => {
  const target = runtime(["pending", result(9, 0)]);
  let canceled = false;
  await expect(admitInitialUserspaceProcess(target, { kind: "file", filename: "/bin/alias" }, input, () => {
    if (canceled) throw new Error("cancelled admission");
  }, () => { canceled = true; return Promise.resolve(true); })).rejects.toThrow("cancelled admission");
  expect(target.sources).toHaveLength(1);
});

it("retains Linux failures without reading storage for permission errors", async () => {
  const target = runtime([result(0, 13)]);
  await expect(admitInitialUserspaceProcess(target, { kind: "file", filename: "/private" }, input, () => {}, () =>
    Promise.reject(new Error("unexpected host read"))
  )).rejects.toMatchObject({ code: "PERMISSION_DENIED", detail: { errno: 13 } });
});

it("distinguishes resource EAGAIN from a pending read and bounds retries", async () => {
  const limited = runtime([result(0, 11)]);
  await expect(admitInitialUserspaceProcess(limited, { kind: "file", filename: "/file" }, input, () => {}, () => Promise.reject(new Error("unrelated read must remain queued"))))
    .rejects.toMatchObject({ code: "QUOTA_EXCEEDED", detail: { errno: 11 } });
  const repeated = runtime(Array.from({ length: 64 }, () => "pending" as const));
  await expect(admitInitialUserspaceProcess(repeated, { kind: "file", filename: "/file" }, input, () => {}, () => Promise.resolve(true)))
    .rejects.toMatchObject({ code: "GUEST_CRASH" });
  expect(repeated.sources).toHaveLength(64);
});

it("keeps missing read requests and Wasm failures separate from Linux errno", async () => {
  const pending = runtime(["pending"]);
  await expect(admitInitialUserspaceProcess(pending, { kind: "file", filename: "/file" }, input, () => {}, () => Promise.resolve(false)))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  const boundary = runtime(["boundary-error"]);
  await expect(admitInitialUserspaceProcess(boundary, { kind: "file", filename: "/file" }, input, () => {}, () => Promise.reject(new Error("unexpected read"))))
    .rejects.toMatchObject({ code: "GUEST_CRASH", message: "Userspace Wasm file process admission failed with status 2" });
});

// The staging buffer and the queue of host reads belong to the runtime, so two admissions that overlap would write over each
// other's program and take each other's reads ("native executable read has no host request" for the second native process).
function sharedRuntime() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const sources: string[] = [];
  const attempts = new Map<string, number>();
  let pid = 100;
  const decoder = new TextDecoder();
  const instance: WebAssembly.Instance = { exports: {
    oxidevm_userspace_staging_resize: () => 0,
    oxidevm_userspace_staging_ptr: () => 64,
    oxidevm_userspace_file_record_len: () => 8,
    oxidevm_userspace_spawn_top_level_executable: (length: number) => {
      const name = decoder.decode(new Uint8Array(memory.buffer, 64, length).slice()).replace(/\0.*$/u, "");
      sources.push(name);
      const seen = attempts.get(name) ?? 0;
      attempts.set(name, seen + 1);
      if (seen === 0) return 3;
      pid += 1;
      new Uint8Array(memory.buffer, 64, 8).set(result(pid, 0));
      return 0;
    },
  } };
  return { memory, instance, sources };
}
const yieldOnce = (): Promise<void> => new Promise(resolve => { queueMicrotask(resolve); });

it("admits overlapping programs one at a time, in the order they asked", async () => {
  const target = sharedRuntime();
  const read = async (): Promise<boolean> => { await yieldOnce(); await yieldOnce(); return true; };
  const [first, second] = await Promise.all([
    admitInitialUserspaceProcess(target, { kind: "file", filename: "/bin/a" }, input, () => {}, read),
    admitInitialUserspaceProcess(target, { kind: "file", filename: "/bin/b" }, input, () => {}, read),
  ]);
  expect([first, second]).toEqual([101, 102]);
  expect(target.sources.map(name => name.split("\0")[0])).toEqual(["/bin/a", "/bin/a", "/bin/b", "/bin/b"]);
});

it("lets the next admission run after one failed, and checks for cancellation only when its turn comes", async () => {
  const target = sharedRuntime();
  const failing = admitInitialUserspaceProcess(target, { kind: "file", filename: "/bin/a" }, input, () => {}, () => Promise.reject(new Error("storage went away")));
  let canceled = false;
  const waiting = admitInitialUserspaceProcess(target, { kind: "file", filename: "/bin/b" }, input, () => { if (canceled) throw new Error("cancelled admission"); }, () => Promise.resolve(true));
  const later = admitInitialUserspaceProcess(target, { kind: "file", filename: "/bin/c" }, input, () => {}, () => Promise.resolve(true));
  canceled = true; // after the others were queued, before the second one's turn
  await expect(failing).rejects.toThrow("storage went away");
  await expect(waiting).rejects.toThrow("cancelled admission");
  expect(await later).toBe(101);
  expect(target.sources.map(name => name.split("\0")[0])).toEqual(["/bin/a", "/bin/c", "/bin/c"]);
});
