import { describe, expect, it, vi } from "vitest";
import { stage, type TestRuntime } from "./userspace-tier2.test-support.js";

describe("Userspace probe staging", () => {
  it("copies separate process records directly into fresh Wasm memory after growth", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const previousBuffer = memory.buffer;
    const lengths: number[] = [];
    const resize = (length: number): number => { lengths.push(length); memory.grow(1); return 0; };
    const runtime: Pick<TestRuntime, "instance" | "memory"> = {
      memory,
      instance: { exports: {
        oxidevm_userspace_staging_resize: resize,
        oxidevm_userspace_staging_ptr: () => 65_536,
      } },
    };
    const elf = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46);
    const args = Uint8Array.of(2, 0, 3), cwd = Uint8Array.of(47);
    const targets: unknown[] = [];
    const copy = vi.spyOn(Uint8Array.prototype, "set");
    try {
      stage(runtime, elf, args, new Uint8Array(), cwd);
      for (const [index, [source]] of copy.mock.calls.entries()) {
        if (source === elf) targets.push(copy.mock.contexts[index]);
      }
    }
    finally { copy.mockRestore(); }

    expect(lengths).toEqual([8]);
    expect(memory.buffer).not.toBe(previousBuffer);
    expect([...new Uint8Array(memory.buffer, 65_536, 8)]).toEqual([0x7f, 0x45, 0x4c, 0x46, 2, 0, 3, 47]);
    expect(targets).toHaveLength(1);
    const target = targets[0];
    if (!(target instanceof Uint8Array)) throw new Error("ELF staging destination is not a byte view");
    expect(target.buffer).toBe(memory.buffer);
    expect([...elf]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  });

  it("does not read or write staging when the native resize fails", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer).fill(91);
    const pointer = vi.fn(() => 0);
    const runtime: Pick<TestRuntime, "instance" | "memory"> = {
      memory,
      instance: { exports: {
        oxidevm_userspace_staging_resize: () => 2,
        oxidevm_userspace_staging_ptr: pointer,
      } },
    };
    expect(() => stage(runtime, Uint8Array.of(1), Uint8Array.of(2))).toThrow("unexpected status 2");
    expect(pointer).not.toHaveBeenCalled();
    expect(new Uint8Array(memory.buffer).every(byte => byte === 91)).toBe(true);
  });
});
