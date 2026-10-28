import { expect, it, vi } from "vitest";
import { NativeValues, type NativeResult } from "./values.js";

for (const runtime of ["node", "bun"] as const) {
  for (const version of [8, 9, 10]) {
    it(`${runtime} version ${version} primitive reference admission preserves pending exceptions`, () => {
      const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, {
        runtime, claim: () => undefined, retire: () => undefined,
      });
      values.registerEnvironment(1n, version);
      const expected = runtime === "node" && version >= 10 ? 0 : 1, marker = new Error("pending reference");
      try {
        values.withEnvironment(1n, () => {
          for (const input of [undefined, null, false, 42, 42n, "retained"]) for (const count of [0n, 1n]) for (const pending of [false, true]) {
            const handle = values.add(input);
            if (pending) expect(values.dispatch("napi_throw", [values.add(marker)], new Uint8Array()).status).toBe(0);
            const result = values.dispatch("napi_create_reference", [handle, count], new Uint8Array());
            expect(result.status).toBe(expected);
            if (expected === 1) expect(result.args).toEqual([]);
            else {
              const id = result.args[0]; if (id === undefined) throw new Error("Missing primitive reference");
              expect(values.dispatch("napi_delete_reference", [id], new Uint8Array()).status).toBe(0);
            }
            let observed: unknown;
            try { values.throwPending(); } catch (error) { observed = error; }
            expect(observed).toBe(pending ? marker : undefined);
          }
        });
      } finally { values.dispose(); }
    });
  }
}

const empty = new Uint8Array();
function fixture() {
  const values = new NativeValues(() => undefined, () => undefined);
  values.registerEnvironment(1n, 8); values.registerEnvironment(2n, 10);
  return values;
}
function reference(values: NativeValues, input: unknown, count = 1): bigint {
  const result = values.dispatch("napi_create_reference", [values.add(input), BigInt(count)], empty);
  expect(result.status).toBe(0); const id = result.args[0]; if (id === undefined) throw new Error("Missing reference"); return id;
}

it("retains Node-API 10 primitives and clears non-weak values when their count reaches zero", () => {
  const values = fixture();
  values.withEnvironment(1n, () => {
    for (const input of [undefined, null, false, 42, 42n, "value"]) expect(values.dispatch("napi_create_reference", [values.add(input), 1n], empty).status).toBe(1);
  });
  values.withEnvironment(2n, () => {
    for (const input of [undefined, null, false, 42, 42n, "value"]) {
      const id = reference(values, input), result = values.dispatch("napi_get_reference_value", [id], empty);
      const handle = result.args[0]; if (handle === undefined) throw new Error("Missing value"); expect(values.get(handle)).toBe(input);
      expect(values.dispatch("napi_reference_unref", [id], empty)).toMatchObject({ status: 0, args: [0n] });
      expect(values.dispatch("napi_get_reference_value", [id], empty)).toMatchObject({ status: 0, args: [0n] });
      expect(values.dispatch("napi_reference_ref", [id], empty)).toMatchObject({ status: 0, args: [0n] });
      expect(values.dispatch("napi_reference_unref", [id], empty).status).toBe(9);
    }
  });
});

it("supports weak symbols and fences references from another addon environment", () => {
  const values = fixture(), symbol = Symbol("weak");
  const id = values.withEnvironment(1n, () => reference(values, symbol, 0));
  values.withEnvironment(2n, () => {
    for (const operation of ["napi_get_reference_value", "napi_delete_reference", "napi_reference_ref", "napi_reference_unref"]) expect(values.dispatch(operation, [id], empty).status).toBe(1);
  });
  values.withEnvironment(1n, () => {
    const result = values.dispatch("napi_get_reference_value", [id], empty), handle = result.args[0];
    if (handle === undefined) throw new Error("Missing symbol"); expect(values.get(handle)).toBe(symbol);
    expect(values.dispatch("napi_reference_ref", [id], empty).args).toEqual([1n]);
  });
});

it("preserves globally registered symbols at zero references as pinned Node does", () => {
  const values = fixture(), symbol = Symbol.for("registered");
  values.withEnvironment(1n, () => {
    const id = reference(values, symbol, 0), found = values.dispatch("napi_get_reference_value", [id], empty).args[0];
    if (found === undefined) throw new Error("Missing registered symbol"); expect(values.get(found)).toBe(symbol);
    expect(values.dispatch("napi_reference_ref", [id], empty).args).toEqual([1n]);
    expect(values.dispatch("napi_reference_unref", [id], empty).args).toEqual([0n]);
    const retained = values.dispatch("napi_get_reference_value", [id], empty).args[0];
    if (retained === undefined) throw new Error("Missing registered symbol"); expect(values.get(retained)).toBe(symbol);
  });
});

it("returns a resource status at live capacity and fences a recycled slot's previous generation", () => {
  const values = fixture();
  values.withEnvironment(2n, () => {
    const ids = Array.from({ length: 4096 }, () => reference(values, {}));
    expect(values.dispatch("napi_create_reference", [values.add({}), 1n], empty).status).toBe(9);
    const stale = ids.at(-1); if (stale === undefined) throw new Error("Missing last reference");
    for (const id of ids) expect(values.dispatch("napi_delete_reference", [id], empty).status).toBe(0);
    for (let cycle = 0; cycle < 8192; cycle++) {
      const id = reference(values, {}); expect(id).not.toBe(stale); expect(id & 0xfffn).toBe(stale & 0xfffn);
      expect(values.dispatch("napi_get_reference_value", [stale], empty).status).toBe(1);
      expect(values.dispatch("napi_delete_reference", [id], empty).status).toBe(0);
    }
    expect(values.dispatch("napi_get_reference_value", [stale], empty).status).toBe(1);
  });
});

it("returns an empty result after controlled weak collection without reviving the reference", async () => {
  const weak: { value: WeakKey | undefined }[] = [];
  class ControlledWeakRef {
    readonly entry: { value: WeakKey | undefined };
    constructor(value: WeakKey) { this.entry = { value }; weak.push(this.entry); }
    deref(): WeakKey | undefined { return this.entry.value; }
  }
  vi.stubGlobal("WeakRef", ControlledWeakRef);
  try {
    vi.resetModules();
    const { NativeValues: IsolatedValues } = await import("./values.js");
    const values = new IsolatedValues(() => undefined, () => undefined);
    values.registerEnvironment(1n, 8); values.registerEnvironment(2n, 10); values.createScope(1n);
    const id = values.withEnvironment(2n, () => values.withScope(1n, () => reference(values, {}, 0)));
    values.retireScope(1n); for (const entry of weak) entry.value = undefined;
    values.withEnvironment(2n, () => {
      expect(values.dispatch("napi_get_reference_value", [id], empty)).toMatchObject({ status: 0, args: [0n] });
      expect(values.dispatch("napi_reference_ref", [id], empty)).toMatchObject({ status: 0, args: [0n] });
      expect(values.dispatch("napi_delete_reference", [id], empty).status).toBe(0);
    });
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
});

for (const environment of [1n, 2n]) {
  for (const poison of ["getter", "replacement"] as const) {
    it(`environment ${environment} symbol references ignore application keyFor ${poison}`, () => {
      const values = fixture(), inputs = [Symbol("weak intrinsic"), Symbol.for("registered intrinsic")];
      const handles = inputs.map(input => values.add(input)), define = Object.defineProperty;
      const original = Object.getOwnPropertyDescriptor(Symbol, "keyFor");
      if (original === undefined) throw new Error("Missing symbol registry intrinsic");
      const observations: NativeResult[][] = []; let traps = 0;
      define(Symbol, "keyFor", poison === "getter"
        ? { configurable: true, get() { traps++; throw new Error("application symbol registry getter"); } }
        : { configurable: true, writable: true, value() { traps++; return undefined; } });
      try {
        values.withEnvironment(environment, () => {
          for (const input of handles) {
            const created = values.dispatch("napi_create_reference", [input, 0n], empty), results = [created];
            const id = created.args[0];
            if (created.status === 0 && id !== undefined) {
              results.push(values.dispatch("napi_get_reference_value", [id], empty));
              results.push(values.dispatch("napi_reference_ref", [id], empty));
              results.push(values.dispatch("napi_reference_unref", [id], empty));
              results.push(values.dispatch("napi_get_reference_value", [id], empty));
              results.push(values.dispatch("napi_delete_reference", [id], empty));
              results.push(values.dispatch("napi_get_reference_value", [id], empty));
            }
            observations.push(results);
          }
        });
      } finally { define(Symbol, "keyFor", original); }
      try {
        expect(traps).toBe(0); expect(observations).toHaveLength(2);
        for (const [index, results] of observations.entries()) {
          expect(results.map(result => result.status)).toEqual([0, 0, 0, 0, 0, 0, 1]);
          expect(results[2]?.args).toEqual([1n]); expect(results[3]?.args).toEqual([0n]);
          for (const position of [1, 4]) {
            const handle = results[position]?.args[0];
            if (handle === undefined) throw new Error("Missing retained symbol");
            expect(values.get(handle)).toBe(inputs[index]);
          }
        }
        expect(() => values.throwPending()).not.toThrow();
      } finally { values.dispose(); }
    });
  }
}

for (const environment of [1n, 2n]) {
  for (const poison of ["constructor-getter", "constructor-replacement", "deref-getter", "deref-replacement"] as const) {
    it(`environment ${environment} references ignore application WeakRef ${poison}`, () => {
      const values = fixture(), inputs = [{}, () => undefined, Symbol("weak reference intrinsic")];
      const handles = inputs.map(input => values.add(input)), define = Object.defineProperty, owner = WeakRef;
      const constructor = Object.getOwnPropertyDescriptor(globalThis, "WeakRef");
      const deref = Object.getOwnPropertyDescriptor(owner.prototype, "deref");
      if (constructor === undefined || deref === undefined) throw new Error("Missing weak reference intrinsics");
      const observations: NativeResult[][] = []; let traps = 0;
      function replacementConstructor(): never { traps++; throw new Error("application WeakRef constructor"); }
      if (poison === "constructor-getter") define(globalThis, "WeakRef", { configurable: true, get() { traps++; throw new Error("application WeakRef getter"); } });
      if (poison === "constructor-replacement") define(globalThis, "WeakRef", { configurable: true, writable: true, value: replacementConstructor });
      if (poison === "deref-getter") define(owner.prototype, "deref", { configurable: true, get() { traps++; throw new Error("application deref getter"); } });
      if (poison === "deref-replacement") define(owner.prototype, "deref", { configurable: true, writable: true, value() { traps++; return undefined; } });
      try {
        values.withEnvironment(environment, () => {
          for (const input of handles) {
            const created = values.dispatch("napi_create_reference", [input, 0n], empty), results = [created];
            const id = created.args[0];
            if (created.status === 0 && id !== undefined) {
              results.push(values.dispatch("napi_get_reference_value", [id], empty));
              results.push(values.dispatch("napi_reference_ref", [id], empty));
              results.push(values.dispatch("napi_reference_unref", [id], empty));
              results.push(values.dispatch("napi_get_reference_value", [id], empty));
              results.push(values.dispatch("napi_delete_reference", [id], empty));
              results.push(values.dispatch("napi_get_reference_value", [id], empty));
            }
            observations.push(results);
          }
        });
      } finally { define(globalThis, "WeakRef", constructor); define(owner.prototype, "deref", deref); }
      try {
        expect(traps).toBe(0); expect(observations).toHaveLength(3);
        for (const [index, results] of observations.entries()) {
          expect(results.map(result => result.status)).toEqual([0, 0, 0, 0, 0, 0, 1]);
          expect(results[2]?.args).toEqual([1n]); expect(results[3]?.args).toEqual([0n]);
          for (const position of [1, 4]) {
            const handle = results[position]?.args[0];
            if (handle === undefined) throw new Error("Missing retained weak value");
            expect(values.get(handle)).toBe(inputs[index]);
          }
        }
        expect(() => values.throwPending()).not.toThrow();
      } finally { values.dispose(); }
    });
  }
}
