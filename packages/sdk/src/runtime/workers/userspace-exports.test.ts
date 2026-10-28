import { assertUserspaceCheckpointStatus } from "./userspace-exports.js";
import { describe, expect, it } from "vitest";

import { callUserspaceU32, callUserspaceU64 } from "./userspace-exports.js";
import { servicePreviewRuntime, type PreviewProcess } from "./userspace-preview-runtime.js";
import { VMError } from "../errors.js";

/** (module (func (export "high") (result i32) i32.const 0x80000000)
 *          (func (export "blocked") (result i32) i32.const 0xfffffffe)) */
const SIGNED_RESULTS = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
  0x03, 0x03, 0x02, 0x00, 0x00,
  0x07, 0x12, 0x02, 0x04, 0x68, 0x69, 0x67, 0x68, 0x00, 0x00,
  0x07, 0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x65, 0x64, 0x00, 0x01,
  0x0a, 0x0f, 0x02, 0x08, 0x00, 0x41, 0x80, 0x80, 0x80, 0x80, 0x78, 0x0b,
  0x04, 0x00, 0x41, 0x7e, 0x0b,
);

/** A preview process whose `preview_write` returns `result` the way Wasm hands an i32 to JS. */
function previewProcess(result: number): PreviewProcess & { wakes: number } {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const process = {
    pid: 7,
    memory,
    wakes: 0,
    instance: {
      exports: {
        oxidevm_userspace_staging_resize: () => 0,
        oxidevm_userspace_staging_ptr: () => 0,
        oxidevm_userspace_preview_write: () => result,
      },
    },
    wake() {
      process.wakes += 1;
    },
  };
  return process;
}

describe("Userspace u32 exports", () => {
  it("returns the unsigned value of results that Wasm hands to JavaScript as negative", async () => {
    const { instance } = await WebAssembly.instantiate(SIGNED_RESULTS);
    // A pointer above 2 GiB and the u32::MAX - 1 sentinel both arrive negative.
    const high = instance.exports["high"];
    if (typeof high !== "function") throw new TypeError("missing test export");
    const raw: unknown = Reflect.apply(high, undefined, []);
    expect(raw).toBe(-0x8000_0000);
    expect(callUserspaceU32(instance, "high")).toBe(0x8000_0000);
    expect(callUserspaceU32(instance, "blocked")).toBe(0xffff_fffe);
  });

  it("rejects a missing export and a result that is not a 32-bit integer", () => {
    const instance = { exports: { fraction: () => 0.5 } };
    expect(() => callUserspaceU32(instance, "absent")).toThrow("Userspace export absent is missing");
    expect(() => callUserspaceU32(instance, "fraction")).toThrow(
      "Userspace export fraction returned an invalid value",
    );
  });

  it("reports a blocked or failed preview write instead of throwing", () => {
    const write = { kind: "write", generation: 1n, process: 7, connection: 1, bytes: Uint8Array.of(1) } as const;
    const blocked = previewProcess(-2);
    expect(servicePreviewRuntime(write, [blocked])).toEqual({ kind: "blocked" });
    expect(blocked.wakes).toBe(1);
    expect(servicePreviewRuntime(write, [previewProcess(-1)])).toEqual({
      kind: "error",
      code: "write",
    });
  });
});

/** (module (func (export "max") (result i64) i64.const -1)) */
const SIGNED_U64 = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7e,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x6d, 0x61, 0x78, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x42, 0x7f, 0x0b,
);

describe("callUserspaceU64", () => {
  it("returns the unsigned value of a u64 export that Wasm hands over as negative", async () => {
    const { instance } = await WebAssembly.instantiate(SIGNED_U64);
    expect(callUserspaceU64(instance, "max")).toBe(0xffff_ffff_ffff_ffffn);
  });

  it("refuses a missing export and a result that is not a bigint", () => {
    const exports: WebAssembly.Exports = { number: () => 1 };
    expect(() => callUserspaceU64({ exports }, "missing")).toThrow("missing");
    expect(() => callUserspaceU64({ exports }, "number")).toThrow("invalid");
  });
});

it("distinguishes checkpoint quota, invalid operations and destructive recovery status", () => {
  expect(() => assertUserspaceCheckpointStatus(0, "capture")).not.toThrow();
  for (const [status, code] of [[3, "QUOTA_EXCEEDED"], [4, "STORAGE_ERROR"], [17, "PROTOCOL_ERROR"]] as const) {
    try {
      assertUserspaceCheckpointStatus(status, "restore");
      throw new Error("Failed checkpoint status was accepted");
    } catch (error) {
      if (!(error instanceof VMError)) throw error;
      expect(error.code).toBe(code);
      if (status === 4) expect(error.detail?.["recoveryRequired"]).toBe(true);
    }
  }
});
