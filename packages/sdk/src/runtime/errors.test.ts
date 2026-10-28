import { describe, expect, it } from "vitest";
import {
  decodeSerializedError,
  deserializeError,
  isVMError,
  serializeUnknownError,
  VMError,
  normalizeStorageError,
  withCleanupFailure,
} from "./errors.js";

it.each(["SecurityError", "NotAllowedError"])("explains browser storage refusal (%s) without disguising it as a license error", name => {
  const failure = normalizeStorageError(new DOMException("Storage directory access is denied.", name));
  const returned = deserializeError(decodeSerializedError(structuredClone(serializeUnknownError(failure))));
  expect(returned).toMatchObject({ code: "PERMISSION_DENIED", detail: { name, reason: "browser-storage-blocked" } });
  expect(returned.message).toContain("Allow site storage");
  expect(returned.message).toContain("retry");
});

/** (module (func (export "run") unreachable)) */
const TRAP = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  7, 7, 1, 3, 114, 117, 110, 0, 0,
  10, 5, 1, 3, 0, 0, 11,
);

it("recognizes owned protocol errors without changing their public shape or inspecting application objects", () => {
  const owned = new VMError("PROTOCOL_ERROR", "owned"), marker = new Error("application trap");
  const structural: VMError = { name: "VMError", message: "application", code: "PROTOCOL_ERROR", detail: undefined };
  let traps = 0;
  const handler = { get() { traps++; throw marker; }, getPrototypeOf() { traps++; throw marker; }, has() { traps++; throw marker; } };
  const revoked = Proxy.revocable(owned, handler); revoked.revoke();
  const inputs: readonly unknown[] = [owned, structural, Object.create(VMError.prototype), new Proxy(owned, handler), revoked.proxy, new Error("application"), null, undefined];
  const descriptor = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
  const weakDescriptors = (["has", "add"] as const).map(name => ({ name, descriptor: Object.getOwnPropertyDescriptor(WeakSet.prototype, name) }));
  let results: readonly boolean[], created: VMError;
  Object.defineProperty(Error, Symbol.hasInstance, { configurable: true, get() { traps++; throw marker; } });
  for (const item of weakDescriptors) Object.defineProperty(WeakSet.prototype, item.name, { configurable: true, value() { traps++; throw marker; } });
  try { created = new VMError("INVALID_ARGUMENT", "later"); results = [...inputs.map(isVMError), isVMError(created)]; }
  finally {
    if (descriptor === undefined) Reflect.deleteProperty(Error, Symbol.hasInstance);
    else Object.defineProperty(Error, Symbol.hasInstance, descriptor);
    for (const item of weakDescriptors) {
      if (item.descriptor === undefined) Reflect.deleteProperty(WeakSet.prototype, item.name);
      else Object.defineProperty(WeakSet.prototype, item.name, item.descriptor);
    }
  }
  expect(results).toEqual([true, false, false, false, false, false, false, false, true]);
  expect(Object.keys(created).sort()).toEqual(["code", "detail", "name"]);
  expect(traps).toBe(0);
});

describe("worker error evidence", () => {
  it("retains a genuine Wasm trap's original stack across structured cloning and decoding", async () => {
    const { instance } = await WebAssembly.instantiate(TRAP);
    const run = instance.exports["run"];
    if (typeof run !== "function") throw new Error("Missing real trap export");
    let failure: unknown;
    try { Reflect.apply(run, undefined, []); } catch (error: unknown) { failure = error; }
    if (!(failure instanceof WebAssembly.RuntimeError)) throw new Error("Expected a genuine Wasm trap");
    expect(failure.stack).toMatch(/wasm:\/\/wasm\//u);
    const error = deserializeError(decodeSerializedError(structuredClone(serializeUnknownError(failure))));
    expect(error.code).toBe("PROTOCOL_ERROR");
    expect(error.message).toBe(failure.message);
    expect(error.detail).toEqual({ wasmTrap: { stack: failure.stack, truncated: false } });
  });

  it("bounds a large native trap stack and discloses truncation", () => {
    const failure = new WebAssembly.RuntimeError("x".repeat(16_384));
    const stack = failure.stack;
    if (stack === undefined) throw new Error("Native runtime error stack missing");
    expect(stack.length).toBeGreaterThan(8192);
    const error = decodeSerializedError(structuredClone(serializeUnknownError(failure)));
    expect(error.message).toBe(failure.message);
    expect(error.detail).toEqual({ wasmTrap: { stack: stack.slice(0, 8192), truncated: true } });
  });

  it("keeps a native trap with no stack explicit", () => {
    const failure = new WebAssembly.RuntimeError("unreachable");
    delete failure.stack;
    expect(serializeUnknownError(failure)).toEqual({
      code: "PROTOCOL_ERROR", message: "unreachable", detail: { wasmTrap: { stack: null, truncated: false } },
    });
  });

  it("preserves typed SDK error details and ordinary error serialization", () => {
    const failure = new VMError("GUEST_CRASH", "guest exited", { status: 7 });
    expect(deserializeError(decodeSerializedError(structuredClone(serializeUnknownError(failure))))).toMatchObject({
      code: "GUEST_CRASH", message: "guest exited", detail: { status: 7 },
    });
    expect(serializeUnknownError(new Error("ordinary failure"))).toEqual({ code: "PROTOCOL_ERROR", message: "ordinary failure" });
    expect(serializeUnknownError("plain failure")).toEqual({ code: "PROTOCOL_ERROR", message: "plain failure" });
  });
});

describe("cleanup failure evidence", () => {
  it("keeps the original failure's code, message and detail beside a failed cleanup", () => {
    const failure = new VMError("RELAY_ERROR", "Relay: approval-denied", { reason: "approval-denied" });
    const reported = withCleanupFailure(failure, new VMError("GUEST_CRASH", "workers did not stop"));
    expect(reported).toBeInstanceOf(VMError);
    expect(reported).toMatchObject({ code: "RELAY_ERROR", message: "Relay: approval-denied", detail: { reason: "approval-denied", cleanupFailed: true, cleanupError: { code: "GUEST_CRASH", message: "workers did not stop" } } });
    expect(withCleanupFailure(new TypeError("lost"), "gone")).toMatchObject({ code: "PROTOCOL_ERROR", message: "lost", detail: { cleanupFailed: true, cleanupError: { code: "PROTOCOL_ERROR", message: "gone" } } });
  });
});
