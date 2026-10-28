import { Buffer as NativeBuffer } from "node:buffer";
import { Buffer as BrowserBuffer } from "buffer/index.js";
import { expect, it } from "vitest";

it("matches Node Buffer search and equality for byte views, empty needles and offsets", () => {
  const backing = Uint8Array.from([0, 98, 97, 0]), view = backing.subarray(1, 3);
  for (const text of ["abba", "", "ababab"]) {
    const actual = BrowserBuffer.from(text), expected = NativeBuffer.from(text);
    for (const needle of [view, new Uint8Array(), BrowserBuffer.alloc(0), "", 98]) {
      for (const offset of [undefined, null, NaN, -10, -1, 0, 1, 1.9, 10, "utf8"]) {
        for (const name of ["indexOf", "lastIndexOf", "includes"] as const) {
          expect(Reflect.apply(actual[name].bind(actual), undefined, [needle, offset]), `${name}:${text}:${String(offset)}`).toEqual(Reflect.apply(expected[name].bind(expected), undefined, [needle, offset]));
        }
      }
    }
  }
  expect(BrowserBuffer.from("ba").equals(view)).toBe(true);
  expect(BrowserBuffer.from("bb").equals(view)).toBe(false);
});
