import { expect, it } from "vitest";
import { acknowledgeUserspaceOutput, readUserspaceOutput } from "./userspace-output.js";

it("bounds a packet and releases only its delivered prefix while later bytes stay queued", () => {
  const memory = new WebAssembly.Memory({ initial: 3 });
  let bytes = new Uint8Array(65537).fill(120);
  const runtime = { memory, instance: { exports: {
    oxidevm_userspace_process_stdout_ptr: (pid: number) => {
      expect(pid).toBe(2); new Uint8Array(memory.buffer, 32, bytes.length).set(bytes); return 32;
    },
    oxidevm_userspace_stdout_len: () => bytes.length,
    oxidevm_userspace_process_output_acknowledge: (pid: number, stream: number, count: number) => {
      expect(pid).toBe(2); expect(stream).toBe(0); bytes = bytes.slice(count); return 0;
    },
  } } };
  const delivered = readUserspaceOutput(runtime, 2, "stdout");
  expect(delivered.length).toBe(65536);
  bytes = new Uint8Array([...bytes, 121]);
  expect(delivered.at(-1)).toBe(120);
  acknowledgeUserspaceOutput(runtime, 2, "stdout", delivered.length);
  expect(readUserspaceOutput(runtime, 2, "stdout")).toEqual(Uint8Array.of(120, 121));
});

it("rejects malformed capture bounds and failed Rust acknowledgements", () => {
  const runtime = { memory: new WebAssembly.Memory({ initial: 1 }), instance: { exports: {
    oxidevm_userspace_process_stderr_ptr: () => 65535,
    oxidevm_userspace_stderr_len: () => 2,
    oxidevm_userspace_process_output_acknowledge: () => 2,
  } } };
  expect(() => readUserspaceOutput(runtime, 2, "stderr")).toThrow("buffer is invalid");
  expect(() => acknowledgeUserspaceOutput(runtime, 2, "stderr", 1)).toThrow("acknowledgement failed");
});
