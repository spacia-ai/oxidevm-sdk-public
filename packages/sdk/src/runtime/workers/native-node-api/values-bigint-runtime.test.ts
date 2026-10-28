import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array(), maximum = (1n << 64n) - 1n;
const operations = ["napi_create_bigint_int64", "napi_create_bigint_uint64", "napi_create_bigint_words", "napi_get_value_bigint_int64", "napi_get_value_bigint_uint64"] as const;
for (const runtime of ["node", "bun"] as const) {
  for (const pending of [false, true]) for (const operation of operations) {
    it(`${runtime} ${operation} preserves the pinned pending=${pending} result and exception`, () => {
      const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
      values.registerEnvironment(1n, 8);
      values.withEnvironment(1n, () => {
        const marker = {}, exception = values.add(marker), input = values.add(-1n), words = new Uint8Array(8);
        new DataView(words.buffer).setBigUint64(0, 42n, true);
        const creation = operation.startsWith("napi_create");
        if (pending) expect(values.dispatch("napi_throw", [exception], empty).status).toBe(0);
        const args = creation ? operation === "napi_create_bigint_words" ? [0n] : [42n] : [input];
        const response = values.dispatch(operation, args, operation === "napi_create_bigint_words" ? words : empty);
        const blocked = pending && (operation === "napi_create_bigint_words" ? runtime === "node" : creation && runtime === "bun");
        const partial = pending && runtime === "bun" && operation === "napi_get_value_bigint_uint64";
        expect(response.status).toBe(blocked || partial ? 10 : 0);
        if (blocked) expect(response.args).toEqual([]);
        else if (creation) {
          const handle = response.args[0]; if (handle === undefined) throw new Error("Missing BigInt result");
          expect(values.get(handle)).toBe(42n);
        } else expect(response.args).toEqual(partial ? [maximum] : [maximum, operation === "napi_get_value_bigint_int64" ? 1n : 0n]);
        expect(response.bytes).toEqual(empty);
        expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([pending ? 1n : 0n]);
        const cleared = values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0];
        if (cleared === undefined) throw new Error("Missing cleared exception");
        expect(values.get(cleared)).toBe(pending ? marker : undefined);
      });
    });
  }
  for (const pending of [false, true]) it(`${runtime} rejects a non-BigInt uint64 input before the pending=${pending} output check`, () => {
    const values = new NativeValues(() => undefined, () => undefined, undefined, undefined, undefined, { runtime, claim: () => undefined, retire: () => undefined });
    const marker = {}, input = values.add(42), exception = values.add(marker);
    if (pending) expect(values.dispatch("napi_throw", [exception], empty).status).toBe(0);
    expect(values.dispatch("napi_get_value_bigint_uint64", [input], empty)).toEqual({ status: 17, args: [], bytes: empty });
    if (pending) {
      let thrown: unknown;
      try { values.throwPending(); } catch (error) { thrown = error; }
      expect(thrown).toBe(marker);
    }
  });
}

