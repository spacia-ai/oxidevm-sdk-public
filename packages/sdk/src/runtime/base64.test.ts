import { expect, it } from "vitest";
import { decodeRuntimeBase64 } from "./base64.js";

it("decodes all byte values through the native bulk operation", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const source = btoa(String.fromCharCode(...bytes));
  let calls = 0;
  Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, value: (value: string) => { expect(value).toBe(source); calls++; return bytes; } });
  try { expect(decodeRuntimeBase64(source)).toEqual(bytes); expect(calls).toBe(1); }
  finally { if (descriptor === undefined) Reflect.deleteProperty(Uint8Array, "fromBase64"); else Object.defineProperty(Uint8Array, "fromBase64", descriptor); }
});

it("keeps the byte-exact fallback for supported browsers without a bulk decoder", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, value: undefined });
  const bytes = Uint8Array.from({ length: 65536 }, (_, index) => index & 255);
  try {
    expect(decodeRuntimeBase64(btoa(String.fromCharCode(...bytes)))).toEqual(bytes);
    expect(() => decodeRuntimeBase64("%%%" )).toThrow();
  } finally { if (descriptor === undefined) Reflect.deleteProperty(Uint8Array, "fromBase64"); else Object.defineProperty(Uint8Array, "fromBase64", descriptor); }
});
