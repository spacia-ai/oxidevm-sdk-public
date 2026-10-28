import { expect, it } from "vitest";
import { nodeQuerystring as qs } from "./node-querystring.ts";

it("parses repeated form fields without object prototype mutation", () => {
  const parsed = qs.parse("a=one+two&a=%E2%82%AC&__proto__=safe&bad=%FF&empty");
  expect(Object.getPrototypeOf(parsed)).toBeNull();
  expect(parsed).toEqual({ a: ["one two", "€"], ["__proto__"]: "safe", bad: "�", empty: "" });
  expect(parsed["__proto__"]).toBe("safe");
});

it("supports delimiters, limits and custom decoders with native fallback", () => {
  expect(qs.parse("a:1;a:2;b:3", ";", ":", { maxKeys: 2 })).toEqual({ a: ["1", "2"] });
  expect(qs.parse("x=a+b", "&", "=", { decodeURIComponent: (value: string) => value })).toEqual({ x: "a%20b" });
  expect(qs.parse("x=%ZZ", "&", "=", { decodeURIComponent: () => { throw new Error("bad escape"); } })).toEqual({ x: "%ZZ" });
});

it("stringifies Node primitive arrays and retains module aliases", () => {
  expect(qs.stringify({ a: ["a b", 2, true], empty: [], absent: null, bigint: 3n })).toBe("a=a%20b&a=2&a=true&absent=&bigint=3");
  expect(qs.encode).toBe(qs.stringify);
  expect(qs.decode).toBe(qs.parse);
  expect(qs.escape("!'()*")).toBe("!'()*");
  expect(Array.from(qs.unescapeBuffer("a+%FF", true))).toEqual([97, 32, 255]);
});
