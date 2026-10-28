import { describe, expect, it } from "vitest";

import { MAX_LINKED_JIT_MEMBERS } from "../../jit-cache.js";
import { recordingCore } from "./core.test-support.js";
import { jitLinkSignature, linkJitModules } from "./jit-link.js";

const HEADER = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];

function section(id: number, payload: readonly number[]): number[] {
  return [id, payload.length, ...payload];
}

/** A valid module importing `name` from `m` whose functions all have type 0, `() -> ()`. */
function module(options: {
  readonly name?: string;
  readonly functionTypes?: readonly number[];
  readonly bodies?: readonly (readonly number[])[];
  readonly extra?: readonly number[];
} = {}): Uint8Array<ArrayBuffer> {
  const name = [...new TextEncoder().encode(options.name ?? "f")];
  const functionTypes = options.functionTypes ?? [0];
  const bodies = options.bodies ?? functionTypes.map(() => [0, 0x0b]);
  return new Uint8Array([
    ...HEADER,
    ...section(1, [2, 0x60, 0, 0, 0x60, 1, 0x7f, 0]),
    ...section(2, [1, 1, 0x6d, name.length, ...name, 0, 0]),
    ...section(3, [functionTypes.length, ...functionTypes]),
    ...(options.extra ?? []),
    ...section(10, [bodies.length, ...bodies.flatMap(body => [body.length, ...body])]),
  ]);
}

describe("JIT link signature", () => {
  it("is shared by single-function modules with the same types and imports", () => {
    const signature = jitLinkSignature(module());

    expect(WebAssembly.validate(module())).toBe(true);
    expect(signature).not.toBeNull();
    expect(jitLinkSignature(module())).toBe(signature);
    expect(jitLinkSignature(module({ name: "g" }))).not.toBe(signature);
  });

  it("refuses modules the core linker refuses", () => {
    const refused = [
      module({ functionTypes: [0, 0] }),
      module({ functionTypes: [1] }),
      module({ extra: section(6, [1, 0x7f, 0, 0x41, 0, 0x0b]) }),
    ];
    for (const bytes of refused) {
      expect(WebAssembly.validate(bytes)).toBe(true);
      expect(jitLinkSignature(bytes)).toBeNull();
    }
    const valid = module();
    expect(jitLinkSignature(valid.subarray(0, valid.byteLength - 1))).toBeNull();
    expect(jitLinkSignature(new Uint8Array([...HEADER.slice(0, 4), 2, 0, 0, 0]))).toBeNull();
    expect(jitLinkSignature(new Uint8Array(HEADER))).toBeNull();
  });

  it("groups shared private helpers by exact type and body while ignoring the trace body", () => {
    const first = module({ functionTypes: [0, 1] });
    const sameHelpers = module({ functionTypes: [0, 1], bodies: [[0, 1, 0x0b], [0, 0x0b]] });
    const otherHelper = module({ functionTypes: [0, 1], bodies: [[0, 0x0b], [0, 1, 0x0b]] });
    for (const bytes of [first, sameHelpers, otherHelper]) expect(WebAssembly.validate(bytes)).toBe(true);
    expect(jitLinkSignature(first)).not.toBeNull();
    expect(jitLinkSignature(sameHelpers)).toBe(jitLinkSignature(first));
    expect(jitLinkSignature(otherHelper)).not.toBe(jitLinkSignature(first));
    expect(jitLinkSignature(module({ functionTypes: [0, 1, 1] }))).not.toBeNull();
    expect(jitLinkSignature(first)).not.toBe(jitLinkSignature(module({ functionTypes: [0, 1, 1] })));
  });

  it("rejects missing, excessive, truncated and trace-shaped helpers", () => {
    for (const bytes of [
      module({ functionTypes: [0, 1], bodies: [[0, 0x0b]] }),
      module({ functionTypes: [0, 1, 1, 1] }),
      module({ functionTypes: [0, 1, 0] }),
      module({ functionTypes: [0, 1] }).subarray(0, -1),
    ]) expect(jitLinkSignature(bytes)).toBeNull();
  });
});

describe("JIT module linking", () => {
  it("stages each member as a length-prefixed record and reads the linked module", () => {
    const { core, calls } = recordingCore();
    const first = module();
    const second = module({ name: "g" });

    const linked = linkJitModules(core, [first, second]);

    const length = 8 + first.byteLength + second.byteLength;
    expect(calls.find(({ name }) => name === "oxidevm_jit_link_modules")?.args).toEqual([2, length]);
    const staged = new Uint8Array(core.memory.buffer, 0, length);
    const view = new DataView(staged.buffer, staged.byteOffset);
    expect(view.getUint32(0, true)).toBe(first.byteLength);
    expect(staged.subarray(4, 4 + first.byteLength)).toEqual(first);
    expect(view.getUint32(4 + first.byteLength, true)).toBe(second.byteLength);
    expect(staged.subarray(8 + first.byteLength)).toEqual(second);
    expect(linked).toEqual(new Uint8Array());
  });

  it("reports a refused link and bounds its members", () => {
    const { core } = recordingCore();
    const refusing = { ...core, exports: { ...core.exports, oxidevm_jit_link_modules: () => 1 } };

    expect(linkJitModules(refusing, [module(), module()])).toBeUndefined();
    expect(() => linkJitModules(core, [])).toThrow("JIT link members are invalid");
    expect(() => linkJitModules(core, Array.from({ length: MAX_LINKED_JIT_MEMBERS + 1 }, () => module())))
      .toThrow("JIT link members are invalid");
  });
});
