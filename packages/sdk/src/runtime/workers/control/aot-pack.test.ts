import { describe, expect, it } from "vitest";

import { validateAotPackModule } from "./aot-pack.js";

const sourceSha256 = "00".repeat(32);

describe("AOT compiled member capability identity", () => {
  it("accepts exact historical and current contracts", () => {
    for (const [version, capabilityRevision] of [[1, 0], [2, 0], [2, 1]] as const) {
      expect(() => validateAotPackModule(fixture(version, capabilityRevision), {
        sourceSha256, memberCount: 1,
      })).not.toThrow();
    }
  });

  it("rejects historical reinterpretation, unknown capabilities, and reserved bytes", () => {
    for (const [version, capabilityRevision, reserved] of [
      [1, 1, 0], [2, 2, 0], [2, 255, 0], [2, 1, 1], [3, 0, 0],
    ] as const) {
      expect(() => validateAotPackModule(fixture(version, capabilityRevision, reserved), {
        sourceSha256, memberCount: 1,
      })).toThrow(/metadata/u);
    }
    expect(() => validateAotPackModule(fixture(2, 1), {
      sourceSha256: "ff".repeat(32), memberCount: 1,
    })).toThrow(/metadata/u);
    expect(() => validateAotPackModule(fixture(2, 1), {
      sourceSha256, memberCount: 2,
    })).toThrow(/count/u);
  });

  it("rejects obsolete unqualified port imports before admitting a pack", () => {
    expect(() => validateAotPackModule(fixture(2, 1, 0, true), {
      sourceSha256, memberCount: 1,
    })).toThrow(/imports/u);
  });
});

function fixture(version: number, capabilityRevision: number, reserved = 0, obsoletePorts = false): WebAssembly.Module {
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0];
  const section = (id: number, payload: readonly number[]) => bytes.push(id, ...uleb(payload.length), ...payload);
  section(1, [1, 0x60, 0, 0]);
  const imports = [obsoletePorts ? 11 : 9];
  for (const [name, descriptor] of [
    ["memory", [2, 0, 1]],
    ["dispatch_table", [1, 0x70, 0, 1]],
    ["record_dispatch_table", [1, 0x70, 0, 1]],
    ["memory_access", [0, 0]],
    ["invalidate_page", [0, 0]], ["timestamp_counter", [0, 0]], ["side_exit", [0, 0]],
    ["floating_point", [0, 0]], ["image_base", [3, 0x7e, 0]],
  ] as const) imports.push(...text("oxidevm"), ...text(name), ...descriptor);
  if (obsoletePorts) {
    for (const name of ["port_input", "port_output"]) imports.push(...text("oxidevm"), ...text(name), 0, 0);
  }
  section(2, imports);
  section(3, [2, 0, 0]);
  section(7, [2, ...text("member_table"), 1, 0, ...text("record_member_table"), 1, 1]);
  section(10, [2, 2, 0, 0x0b, 2, 0, 0x0b]);
  const identity = new Uint8Array(48);
  const view = new DataView(identity.buffer);
  view.setUint32(0, version, true);
  view.setUint16(44, 1, true);
  view.setUint8(46, capabilityRevision);
  view.setUint8(47, reserved);
  section(0, [...text("oxidevm.aot-pack"), ...identity]);
  return new WebAssembly.Module(new Uint8Array(bytes));
}

function text(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...uleb(bytes.length), ...bytes];
}

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value >>>= 7;
  } while (value !== 0);
  return bytes;
}
