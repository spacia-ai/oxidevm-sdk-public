import { describe, expect, it } from "vitest";
import { decodeUserspaceRegistrationFailure, USERSPACE_REGISTRATION_FAILURE_VERSION } from "./userspace-registration-failure.js";
import { VMError } from "../errors.js";
import { putSource, record } from "./userspace-registration-failure.fixtures.js";

function malformed(bytes: Uint8Array): void {
  try { decodeUserspaceRegistrationFailure(bytes); } catch (error: unknown) {
    expect(error).toBeInstanceOf(VMError);
    if (error instanceof VMError) expect(error.code).toBe("PROTOCOL_ERROR");
    return;
  }
  throw new Error("Invalid registration failure was accepted");
}

describe("registration failure boundary", () => {
  it.each([[1, "selection"], [2, "mutex"], [8, "handoff"]] as const)("retains the exact OXRF5 enter source at %s", (phase, name) => {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint16(4, 5, true);
    bytes[112] = phase;
    putSource(view, 8, 426n, 8);
    expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({ source: { number: 426n }, phase: name });
    view.setUint16(4, 4, true);
    malformed(bytes);
  });

  it("rejects a registration body phase under an enter source", () => {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint16(4, 5, true);
    putSource(view, 8, 426n, 8);
    bytes[112] = 4;
    malformed(bytes);
  });

  it.each([[12, "napi"], [13, "napi-disposal"]] as const)("retains OXRF3 NAPI phase %s as %s", (phase, name) => {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint16(4, 3, true); bytes[112] = phase;
    view.setBigUint64(40, 27n, true); view.setBigUint64(56, 1n, true);
    expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({ phase: name, source: { number: 427n } });
    view.setUint16(4, 2, true); malformed(bytes);
  });

  it("rejects a NAPI failure attributed to another registration family", () => {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint16(4, 3, true); bytes[112] = 13;
    view.setBigUint64(40, 19n, true);
    malformed(bytes);
  });
  it("identifies a completed kernel call waiting for its CPU return boundary", () => {
    const bytes = record(); bytes[112] = 9;
    expect(decodeUserspaceRegistrationFailure(bytes).phase).toBe("returning");
  });
  it("preserves the exact original syscall and optional handoff peer", () => {
    const bytes = record();
    expect(decodeUserspaceRegistrationFailure(bytes)).toEqual({
      source: { pid: 7, tid: 8, guestTicks: 41n, number: 427n, arguments: [3n, 4n, 5n, 6n, 7n, 8n], instructionRip: 0x5000n, nextRip: 0x5002n, addressSpace: 11n },
      openFile: undefined, peer: undefined, phase: "mutex", reason: "not-owner", errno: 5, guestTicks: 51n,
    });
    bytes[114] = 1; putSource(new DataView(bytes.buffer), 128, 426n, 9);
    expect(decodeUserspaceRegistrationFailure(bytes).peer).toMatchObject({ tid: 9, number: 426n });
  });

  it("validates every version, enum, presence flag and reserved field", () => {
    for (const [offset, value] of [[0, 0], [4, USERSPACE_REGISTRATION_FAILURE_VERSION + 1], [6, 255], [7, 0], [112, 0], [112, 10], [113, 0], [113, 15], [114, 2], [115, 2], [116, 0], [120, 1], [127, 1], [128, 1], [232, 1], [255, 1]] as const) {
      const bytes = record(); bytes[offset] = value; malformed(bytes);
    }
    malformed(record().subarray(1));
    malformed(new Uint8Array(257));
    const absent = record(); absent[115] = 0; malformed(absent);
    absent.fill(0, 116, 120);
    expect(decodeUserspaceRegistrationFailure(absent).errno).toBeUndefined();
  });

  it("rejects invalid identities, syscall kinds, RIP spans and source times", () => {
    const invalid = [
      [8, 0n], [12, 0n], [16, 52n], [24, 426n], [88, 0x5000n], [88, 0x5010n], [96, 0n],
    ] as const;
    for (const [offset, value] of invalid) {
      const bytes = record(), view = new DataView(bytes.buffer);
      if (offset === 8 || offset === 12) view.setUint32(offset, Number(value), true);
      else view.setBigUint64(offset, value, true);
      malformed(bytes);
    }
    const bytes = record(); bytes[114] = 1; malformed(bytes);
    putSource(new DataView(bytes.buffer), 128, 60n, 9); malformed(bytes);
  });

  it("accepts zero source ticks consistently with the Rust source codec", () => {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setBigUint64(16, 0n, true); view.setBigUint64(104, 0n, true);
    expect(decodeUserspaceRegistrationFailure(bytes).guestTicks).toBe(0n);
  });

  it("identifies the selected open file after the descriptor slot is closed or reused", () => {
    const bytes = record();
    new DataView(bytes.buffer).setBigUint64(224, 99n, true);
    expect(decodeUserspaceRegistrationFailure(bytes).openFile).toBe(99n);
    bytes[232] = 1;
    malformed(bytes);
  });
});
