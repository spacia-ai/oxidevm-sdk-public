import assertions from "assert/";
import { unavailableNodeApi } from "./node-capability.ts";

type Callable = (...args: unknown[]) => unknown;
function callable(value: unknown): value is Callable { return typeof value === "function"; }
if (!callable(assertions)) throw new TypeError("Invalid assertion compatibility package");
const assertion = assertions;
function operation(name: string): Callable {
  const value: unknown = Reflect.get(assertion, name);
  if (!callable(value)) throw new TypeError(`Missing assert.${name}`);
  return value;
}

// Validate the pinned package boundary; retain its callable aliases, exception
// identities and original values rather than serializing assertion operands.
const members = {
  Assert: function Assert(): never { return unavailableNodeApi("assert.Assert"); },
  CallTracker: function CallTracker(): never { return unavailableNodeApi("assert.CallTracker"); },
  partialDeepStrictEqual: (...args: unknown[]): never => {
    void args;
    return unavailableNodeApi("assert.partialDeepStrictEqual");
  },
  AssertionError: operation("AssertionError"), fail: operation("fail"),
  equal: operation("equal"), notEqual: operation("notEqual"),
  strictEqual: operation("strictEqual"), notStrictEqual: operation("notStrictEqual"),
  deepEqual: operation("deepEqual"), notDeepEqual: operation("notDeepEqual"),
  deepStrictEqual: operation("deepStrictEqual"), notDeepStrictEqual: operation("notDeepStrictEqual"),
  throws: operation("throws"), doesNotThrow: operation("doesNotThrow"),
  rejects: operation("rejects"), doesNotReject: operation("doesNotReject"),
  ifError: operation("ifError"), match: operation("match"), doesNotMatch: operation("doesNotMatch"),
};
const strict = Object.assign(operation("strict"), members, {
  ok: assertion, equal: members.strictEqual, notEqual: members.notStrictEqual,
  deepEqual: members.deepStrictEqual, notDeepEqual: members.notDeepStrictEqual,
});
export const nodeAssert = Object.assign(assertion, members, { ok: assertion, strict });
