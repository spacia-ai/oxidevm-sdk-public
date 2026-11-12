import { expect, it } from "vitest";
import { copyOptions, otherDefaultPort, refuseSetOptions, UNSUPPORTED_CONNECT_OPTIONS } from "./node-connect-options.js";

it("tests each connection key the way Node does: set values are refused by name, unset ones ignored", () => {
  const set: Readonly<Record<string, unknown>> = { localAddress: "10.0.0.2", localPort: 4000, lookup: () => {},
    family: "IPv6", hints: 32, allowHalfOpen: true, onread: { buffer: () => new Uint8Array(1), callback: () => true } };
  // net.Socket ignores an onread without a buffer and callback. createConnection and blockList are not read on every
  // socket (only http.request reads the first; only net.Socket, so plain http, reads the second).
  const unset: Readonly<Record<string, unknown>> = { localAddress: "", localPort: 0, lookup: null, family: 0, hints: 0, allowHalfOpen: false,
    onread: { buffer: 1, callback: () => true }, createConnection: () => {}, blockList: {}, fd: 3 };
  expect(Object.keys(set).sort()).toEqual(Object.keys(UNSUPPORTED_CONNECT_OPTIONS).sort());
  for (const [key, value] of Object.entries(set)) {
    expect(() => refuseSetOptions({ [key]: value }, UNSUPPORTED_CONNECT_OPTIONS, "http.Agent", "https.Agent"))
      .toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE", message: `${key} is not supported for http.Agent`, detail: { lateFailure: "unavailable-builtin", subject: `node:https.Agent ${key}` } }));
  }
  refuseSetOptions(unset, UNSUPPORTED_CONNECT_OPTIONS, "http.Agent", "http.Agent");
  for (const family of [4, 6, "IPv4"]) expect(UNSUPPORTED_CONNECT_OPTIONS["family"]?.(family)).toBe(true);
  expect([443, "443", 0, "", null].map(otherDefaultPort(443))).toEqual([false, false, false, false, false]);
  expect([8443, "80"].map(otherDefaultPort(443))).toEqual([true, true]);
});

it("copies own enumerable options onto a null-prototype object, as Node's spread does", () => {
  class Options { port = 443; get inherited(): boolean { return true; } }
  const options = new Options(); Object.defineProperty(options, "hidden", { value: true, enumerable: false });
  const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"host":"example.test"}');
  const copy = copyOptions(parsed), prototype: unknown = Object.getPrototypeOf(copy);
  expect(prototype).toBe(null);
  expect(Object.keys(copy)).toEqual(["__proto__", "host"]);
  expect(Object.prototype).not.toHaveProperty("polluted");
  expect({ ...copyOptions(options) }).toEqual({ port: 443 });
  expect(Object.keys(copyOptions(null))).toEqual([]);
  expect(Object.keys(copyOptions(undefined))).toEqual([]);
});
