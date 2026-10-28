import { expect, it } from "vitest";
import { files } from "./file-operations.js";
import { decodeJSIdentity, Writer } from "./codec.js";
import { encodeJSRequest } from "./native-abi.js";

it("versions bounded multi-descriptor readiness and refuses mismatched replies", () => {
  const request = files.poll([{ fd: 3, events: 1 }, { fd: 4, events: 4 }]);
  const encoded = encodeJSRequest(decodeJSIdentity(1n, 1n), 1, request.number, request.payload);
  expect(new DataView(encoded.buffer).getUint32(4, true)).toBe(4);
  expect(() => files.poll([])).toThrow();
  expect(() => files.poll(Array.from({ length: 17 }, () => ({ fd: 3, events: 1 })))).toThrow();
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setInt32(0, 3, true); view.setUint16(4, 1, true);
  view.setInt32(8, 4, true); view.setUint16(12, 4, true); view.setUint16(14, 4, true);
  expect(request.decode({ value: 1n, bytes })).toEqual([0, 4]);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
  view.setInt32(8, 5, true);
  expect(() => request.decode({ value: 1n, bytes })).toThrow();
});

it("decodes one bounded canonical-path and Linux-stat result", () => {
  const bytes = new Uint8Array(144);
  new DataView(bytes.buffer).setUint32(24, 0o100640, true);
  const request = files.pathInfo("/link");
  expect(request.number).toBe(65545);
  const result = { value: 0n, bytes: new Writer().raw(bytes).path("/workspace/a.js").finish() };
  expect(request.decode(result)).toMatchObject({ path: "/workspace/a.js", stat: { mode: 0o100640 } });
  for (const corrupt of [result.bytes.subarray(0, -1), new Uint8Array([...result.bytes, 0])]) {
    expect(() => request.decode({ value: 0n, bytes: corrupt })).toThrow();
  }
  expect(() => request.decode({ ...result, value: 1n })).toThrow();
});

it("accepts Rust pipe arrival order and rejects incomplete or duplicated identities", () => {
  const entries = [{ fd: 3, events: 1 }, { fd: 4, events: 4 }] as const;
  const request = files.pollPipes(entries);
  expect(request.number).toBe(65549);
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setInt32(0, 4, true); view.setUint16(4, 4, true); view.setUint16(6, 4, true);
  view.setInt32(8, 3, true); view.setUint16(12, 1, true); view.setUint16(14, 1, true);
  expect(request.decode({ value: 2n, bytes })).toEqual([{ fd: 4, events: 4, revents: 4 }, { fd: 3, events: 1, revents: 1 }]);
  expect(() => files.pollPipes([])).toThrow();
  expect(() => files.pollPipes([entries[0], entries[0]])).toThrow();
  expect(() => files.pollPipes(Array.from({ length: 17 }, (_, fd) => ({ fd, events: 1 })))).toThrow();
  expect(() => request.decode({ value: 1n, bytes })).toThrow();
  expect(() => request.decode({ value: 2n, bytes: bytes.subarray(0, 8) })).toThrow();
  view.setInt32(8, 4, true);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
  view.setInt32(8, 5, true);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
  view.setInt32(8, 3, true); view.setUint16(14, 64, true);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
});
