import { expect, it, vi } from "vitest";
import { RUNTIME_PROBE_DEADLINE_MS } from "../js-process/runtime-probe.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { runRuntimeProbeProcess } from "./userspace-runtime-probe-process.js";

function fixture(pending = false) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const names: string[] = [], killed: number[] = [], disconnected: number[] = [];
  let connecting = 0;
  const runtime = { memory, instance: { exports: {
    oxidevm_userspace_staging_resize: () => 0,
    oxidevm_userspace_staging_ptr: () => 64,
    oxidevm_userspace_file_record_len: () => 8,
    oxidevm_userspace_spawn_runtime_probe: (length: number) => {
      names.push(new TextDecoder().decode(new Uint8Array(memory.buffer, 64, length)));
      if (pending) { pending = false; return 3; }
      const bytes = new Uint8Array(memory.buffer, 64, 8); bytes.fill(0);
      new DataView(memory.buffer).setUint32(64, 9, true);
      return 0;
    },
  } } };
  const ports = {
    runtime, active: () => true, serviceRead: () => Promise.resolve(true),
    connect: (pid: number, port: MessagePort) => {
      connecting++; expect(pid).toBe(9);
      port.onmessage = () => {};
      port.postMessage({ version: PROTOCOL_VERSION, sessionId: 7, sequence: 1, type: "stdout", data: new TextEncoder().encode("build\n") });
      port.postMessage({ version: PROTOCOL_VERSION, sessionId: 7, sequence: 2, type: "exit", termination: { kind: "exit", code: 0 } });
      return 7;
    },
    kill: (pid: number) => { killed.push(pid); },
    disconnect: (pid: number) => { disconnected.push(pid); },
  };
  return { ports, names, killed, disconnected, connecting: () => connecting };
}

it("runs a sealed probe through lazy Rust admission and retires its process connection", async () => {
  const f = fixture(true);
  const run = await runRuntimeProbeProcess(f.ports, "a".repeat(64), new AbortController().signal);
  expect(new TextDecoder().decode(run.stdout)).toBe("build\n");
  expect(run.ending).toEqual({ kind: "exit", code: 0 });
  expect(f.names).toEqual(["a".repeat(64), "a".repeat(64)]);
  expect(f.killed).toEqual([9]);
  expect(f.disconnected).toEqual([9]);
});

it("cancels a probe admission before a PID or process port is published", async () => {
  const f = fixture(true), controller = new AbortController();
  const ports = { ...f.ports, serviceRead: () => { controller.abort(); return Promise.resolve(true); } };
  await expect(runRuntimeProbeProcess(ports, "a".repeat(64), controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  expect(f.connecting()).toBe(0);
  expect(f.killed).toEqual([]);
});

it("kills a published probe if cancellation wins the admission continuation", async () => {
  const f = fixture(), controller = new AbortController();
  const ports = { ...f.ports, active: () => { if (f.names.length > 0) controller.abort(); return true; } };
  await expect(runRuntimeProbeProcess(ports, "a".repeat(64), controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
  expect(f.connecting()).toBe(0);
  expect(f.killed).toEqual([9]);
});

it("bounds lazy probe admission with the runtime probe deadline", async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  const ports = { ...f.ports, serviceRead: (signal: AbortSignal) => new Promise<boolean>((_resolve, reject) => {
    signal.addEventListener("abort", () => { reject(new Error("read cancelled")); }, { once: true });
  }) };
  let settled = false;
  const run = runRuntimeProbeProcess(ports, "a".repeat(64), new AbortController().signal);
  const rejection = expect(run).rejects.toThrow("read cancelled");
  void run.catch(() => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(RUNTIME_PROBE_DEADLINE_MS);
    expect(settled).toBe(true);
    expect(f.connecting()).toBe(0);
    expect(f.killed).toEqual([]);
    await rejection;
  } finally { vi.useRealTimers(); }
});
