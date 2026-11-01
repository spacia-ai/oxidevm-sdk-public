import { describe, expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { formatSums, MAX_SUMS_BYTES, parseSums, releaseId, sha256Hex } from "./sums.js";

const a = "a".repeat(64), b = "b".repeat(64);
const encode = (text: string) => new TextEncoder().encode(text);

describe("SHA256SUMS", () => {
  it("formats sorted lines and parses them back, whatever order the entries come in", () => {
    const bytes = formatSums([{ name: "b.wasm", sha256: b }, { name: "adapter.mjs", sha256: a }]);
    expect(new TextDecoder().decode(bytes)).toBe(`${a}  adapter.mjs\n${b}  b.wasm\n`);
    expect(parseSums(bytes)).toEqual([{ name: "adapter.mjs", sha256: a }, { name: "b.wasm", sha256: b }]);
  });

  it("names a release by the digest of its canonical file", () => {
    const bytes = formatSums([{ name: "x", sha256: a }]);
    expect(releaseId(bytes)).toBe(sha256Hex(bytes));
    expect(releaseId(bytes)).toHaveLength(64);
  });

  it("rejects everything that is not the canonical form, so two files cannot name one release", () => {
    const bad: readonly (readonly [string, Uint8Array])[] = [
      ["empty", encode("")], ["no final newline", encode(`${a}  x`)], ["CRLF", encode(`${a}  x\r\n`)], ["one space", encode(`${a} x\n`)],
      ["binary mode marker", encode(`${a} *x\n`)], ["uppercase digest", encode(`${"A".repeat(64)}  x\n`)], ["short digest", encode("abc  x\n")],
      ["unsorted", encode(`${b}  y\n${a}  x\n`)], ["duplicate", encode(`${a}  x\n${b}  x\n`)], ["blank line", encode(`${a}  x\n\n`)],
      ["dot name", encode(`${a}  .\n`)], ["dot dot", encode(`${a}  ..\n`)], ["hidden name", encode(`${a}  .hidden\n`)], ["path", encode(`${a}  dir/x\n`)],
      ["backslash", encode(`${a}  a\\b\n`)], ["not UTF-8", Uint8Array.of(0xff, 0xfe, 0x0a)], ["too large", new Uint8Array(MAX_SUMS_BYTES + 1).fill(0x61)],
      ["too many files", encode(Array.from({ length: 257 }, (_, index) => `${a}  f${String(index).padStart(4, "0")}\n`).join(""))],
    ];
    for (const [label, bytes] of bad) expect(() => parseSums(bytes), label).toThrow(VMError);
    expect(() => parseSums(encode(`${a}  x\r\n`))).toThrow(/LF line ends/u);
    expect(() => parseSums(encode(`${a}  x\n${b}  x\n`))).toThrow(/lists a file twice/u);
  });
});
