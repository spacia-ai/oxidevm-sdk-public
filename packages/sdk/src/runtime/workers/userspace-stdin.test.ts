import { expect, it } from "vitest";
import { UserspaceStdin, writeUserspaceStdin } from "./userspace-stdin.js";

it("keeps a full Rust input buffer pending until a guest execution slice makes room", async () => {
  let room = false;
  const accepted: number[] = [];
  const input = new UserspaceStdin((_pid, bytes) => {
    if (!room) return 0;
    accepted.push(...bytes); return bytes.length;
  });
  let settled = false;
  const write = input.write(1, 10, Uint8Array.of(1, 2)).then(count => { settled = true; return count; });
  await Promise.resolve();
  expect(settled).toBe(false);
  input.pump();
  expect(accepted).toEqual([]);
  room = true;
  input.pump(); input.pump();
  expect(await write).toBe(2);
  expect(accepted).toEqual([1, 2]);
});

it("bounds one pending transport chunk per process without blocking another process", async () => {
  const input = new UserspaceStdin(pid => pid === 20 ? 1 : 0);
  const pending = input.write(1, 10, Uint8Array.of(1));
  const rejected = expect(pending).rejects.toThrow("closed");
  await expect(input.write(2, 10, Uint8Array.of(2))).rejects.toThrow("pending");
  await expect(input.write(3, 20, Uint8Array.of(3))).resolves.toBe(1);
  await expect(input.write(4, 30, new Uint8Array(1024 * 1024 + 1))).rejects.toThrow("chunk");
  input.rejectProcess(10, new Error("closed"));
  await rejected;
  input.pump();
});

it("cancels an unacknowledged chunk without delivering it after room appears", async () => {
  let room = false, calls = 0;
  const input = new UserspaceStdin(() => { calls++; return room ? 1 : 0; });
  const write = input.write(1, 10, Uint8Array.of(1));
  const rejected = expect(write).rejects.toThrow("cancelled");
  input.cancel(1);
  await rejected;
  room = true; input.pump();
  expect(calls).toBe(1);
  await expect(input.write(2, 10, Uint8Array.of(2))).resolves.toBe(1);
});

it("rejects failed attempts and releases the process slot", async () => {
  let closed = false;
  const input = new UserspaceStdin(() => { if (closed) throw new Error("closed"); return 0; });
  const write = input.write(1, 10, Uint8Array.of(1));
  const rejected = expect(write).rejects.toThrow("closed");
  closed = true; input.pump();
  await rejected;
  await expect(input.write(2, 10, Uint8Array.of(1))).rejects.toThrow("closed");
  await expect(input.write(3, 20, new Uint8Array())).resolves.toBe(0);
});

it("acknowledges only the prefix accepted by a full PTY", async () => {
  let room = 1;
  const accepted: number[] = [];
  const input = new UserspaceStdin((_pid, bytes) => {
    const count = Math.min(room, bytes.length);
    accepted.push(...bytes.subarray(0, count));
    return count;
  });
  expect(await input.write(1, 10, Uint8Array.of(1, 2))).toBe(1);
  room = 0;
  const pending = input.write(2, 10, Uint8Array.of(2, 3));
  room = 1;
  input.pump();
  expect(await pending).toBe(1);
  expect(accepted).toEqual([1, 2]);
});

it.each([-1, 3, 0.5, Number.NaN])("rejects invalid accepted prefix %s", async count => {
  const input = new UserspaceStdin(() => count);
  await expect(input.write(1, 10, Uint8Array.of(1, 2))).rejects.toThrow("accepted");
});

it("does not schedule repeated guest runs when a full PTY accepts no bytes", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let accepted = -11, runs = 0;
  const runtime = { memory, instance: { exports: {
    oxidevm_userspace_staging_resize: () => 0,
    oxidevm_userspace_staging_ptr: () => 32,
    oxidevm_userspace_process_stdin_write: () => accepted,
  } } };
  const input = new UserspaceStdin((pid, bytes) => writeUserspaceStdin(runtime, pid, bytes, () => { runs++; }));
  const pending = input.write(1, 10, Uint8Array.of(1, 2));
  for (let slice = 0; slice < 10; slice++) input.pump();
  expect(runs).toBe(0);
  accepted = 1; input.pump();
  expect(await pending).toBe(1);
  expect(runs).toBe(1);
  expect(new Uint8Array(memory.buffer, 32, 2)).toEqual(Uint8Array.of(1, 2));
});
