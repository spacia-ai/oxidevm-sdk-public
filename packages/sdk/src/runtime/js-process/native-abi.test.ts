import { expect, it } from "vitest";
import { decodeJSIdentity, Reader } from "./codec.js";
import { encodeJSRequest } from "./native-abi.js";

it("marks PATH-aware native requests with OXJR4 before any operation payload", () => {
  const bytes = encodeJSRequest(decodeJSIdentity(1n, 2n), 3, 65548, Uint8Array.of(65));
  const reader = new Reader(bytes);
  expect(reader.raw(8)).toEqual(Uint8Array.of(79, 88, 74, 82, 4, 0, 0, 0));
  expect([reader.u64(), reader.u64(), reader.u64(), reader.u32()]).toEqual([1n, 2n, 3n, 65548]);
  expect(reader.raw(1)).toEqual(Uint8Array.of(65)); reader.end();
});
