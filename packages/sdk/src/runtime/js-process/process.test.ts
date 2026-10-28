import { expect, it } from "vitest";
import { Reader } from "./codec.js";
import { searchPathOperation, spawnPayload, umaskOperation } from "./process.js";

it("encodes mask queries without a temporary change and checks Linux replies", () => {
  const query = umaskOperation();
  expect(query.number).toBe(65547); expect(query.payload).toEqual(new Uint8Array([0]));
  const set = umaskOperation(0xffff_ffff);
  expect(set.payload).toEqual(new Uint8Array([1, 255, 255, 255, 255]));
  expect(query.decode({ value: 0o027n, bytes: new Uint8Array() })).toBe(0o027);
  for (const result of [{ value: 512n, bytes: new Uint8Array() }, { value: -1n, bytes: new Uint8Array() }, { value: 0n, bytes: new Uint8Array([0]) }]) expect(() => query.decode(result)).toThrow();
  for (const mask of [-1, NaN, 1.5, 4294967296]) expect(() => umaskOperation(mask)).toThrow();
});

it("encodes bounded Rust PATH lookup and validates exact returned spelling", () => {
  const query = searchPathOperation("tool", "relative:/usr/bin");
  expect(query.number).toBe(65548);
  const request = new Reader(query.payload); expect(request.text(4095)).toBe("tool"); expect(request.text()).toBe("relative:/usr/bin"); request.end();
  const bytes = new TextEncoder().encode("bin/tool");
  expect(query.decode({ value: 8n, bytes })).toBe("bin/tool");
  for (const result of [{ value: 7n, bytes }, { value: 0n, bytes: new Uint8Array() }, { value: 1n, bytes: Uint8Array.of(255) }, { value: 1n, bytes: Uint8Array.of(0) }, { value: 4096n, bytes: new Uint8Array(4096).fill(65) }]) expect(() => query.decode(result)).toThrow();
  for (const path of ["invalid\0path", "a".repeat(1024 * 1024 + 1)]) expect(() => searchPathOperation("tool", path)).toThrow();
});

it("keeps selected execution spelling separate from the original argv zero", () => {
  const bytes = spawnPayload({ command: "bin/tool", args: ["literal a b"], env: { PATH: "/other" }, cwd: "child" }, false, { kind: "selected", argv0: "tool" }).finish();
  const reader = new Reader(bytes);
  expect(reader.text()).toBe("bin/tool"); expect(reader.strings()).toEqual(["literal a b"]);
  expect(reader.u8()).toBe(1); expect(reader.strings()).toEqual(["PATH=/other"]);
  expect(reader.u8()).toBe(1); expect(reader.text()).toBe("child");
  expect(reader.u8()).toBe(16 | 32); expect(reader.text()).toBe("tool"); reader.end();
  const search = new Reader(spawnPayload({ command: "tool" }, false, { kind: "search", argv0: "custom" }).finish());
  search.text(); search.strings(); expect(search.u8()).toBe(0); expect(search.u8()).toBe(0);
  expect(search.u8()).toBe(16); expect(search.text()).toBe("custom"); search.end();
});
