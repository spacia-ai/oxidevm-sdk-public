import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { nodeAssert } from "./node-assert.js";

it("preserves callable and strict assertion identities and error values", () => {
  expect(nodeAssert.ok).toBe(nodeAssert);
  expect(nodeAssert.strict.strictEqual).toBe(nodeAssert.strictEqual);
  expect(nodeAssert.strict.equal).toBe(nodeAssert.strictEqual);
  nodeAssert("truthy");
  nodeAssert.strictEqual(Number.NaN, Number.NaN);
  const failure = new Error("caller message");
  expect(() => nodeAssert(false, failure)).toThrow(failure);
  let observed: unknown;
  try { nodeAssert.strictEqual(0, -0, "signed zero"); } catch (error) { observed = error; }
  expect(observed).toMatchObject({ name: "AssertionError", code: "ERR_ASSERTION", operator: "strictEqual", actual: 0, expected: -0, message: "signed zero", generatedMessage: false });
});

it("compares cycles, maps, sets and binary views without losing Node identities", () => {
  const left: { self?: unknown } = {}; left.self = left;
  const right: { self?: unknown } = {}; right.self = right;
  nodeAssert.deepStrictEqual(left, right);
  nodeAssert.deepStrictEqual(new Map([[{ key: 1 }, new Set([2, 3])]]), new Map([[{ key: 1 }, new Set([3, 2])]]));
  nodeAssert.deepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]));
  expect(() => nodeAssert.deepStrictEqual(new Uint8Array([1]), new Uint8Array([2]))).toThrow();
  expect(() => nodeAssert.deepStrictEqual({ value: 1 }, { value: "1" })).toThrow();
  nodeAssert.deepEqual({ value: 1 }, { value: "1" });
});

it("checks real thrown and rejected errors, including mismatches", async () => {
  const failure = Object.assign(new Error("request failed"), { code: "EIO" });
  nodeAssert.throws(() => { throw failure; }, { code: "EIO" });
  expect(() => nodeAssert.throws(() => { throw failure; }, TypeError)).toThrow(failure);
  nodeAssert.doesNotThrow(() => undefined);
  await nodeAssert.rejects(Promise.reject(failure), { code: "EIO" });
  await nodeAssert.doesNotReject(Promise.resolve(42));
  await expect(nodeAssert.rejects(Promise.resolve(42))).rejects.toMatchObject({ code: "ERR_ASSERTION" });
});

it("preserves the managed Node 24 deep-comparison rules for opaque and nonenumerable state", () => {
  const first = /value/g; first.lastIndex = 1;
  for (const operation of [nodeAssert.deepEqual, nodeAssert.deepStrictEqual]) {
    for (const [left, right] of [
      [first, /value/g],
      [new Error("failure", { cause: 1 }), new Error("failure", { cause: 2 })],
      [new Error("failure", { cause: undefined }), new Error("failure")],
      [new AggregateError([1], "failure"), new AggregateError([2], "failure")],
      [Promise.resolve(1), Promise.resolve(2)],
      [new WeakMap(), new WeakMap()],
      [new WeakSet(), new WeakSet()],
      [new URL("https://example.com/a"), new URL("https://example.com/b")],
    ]) expect(() => operation(left, right)).toThrow();
    operation(new Date(Number.NaN), new Date(Number.NaN));
    operation(Number.NaN, Number.NaN);
    operation(new URL("https://example.com/a"), new URL("https://example.com/a"));
  }
});

it("attributes assertion APIs outside the admitted package contract", () => {
  for (const [api, invoke] of [
    ["assert.Assert", () => nodeAssert.Assert()],
    ["assert.CallTracker", () => nodeAssert.CallTracker()],
    ["assert.partialDeepStrictEqual", () => nodeAssert.partialDeepStrictEqual({}, {})],
  ] as const) {
    let failure: unknown;
    try { invoke(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(VMError);
    if (!(failure instanceof VMError)) throw new Error("Missing capability failure");
    expect(failure.code).toBe("FEATURE_NOT_AVAILABLE");
    expect(failure.detail?.["api"]).toBe(api);
    expect(failure.detail?.["origin"]).toContain("node-assert.test");
  }
});
