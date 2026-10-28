import { expect, it } from "vitest";
import { decodeBlockedBuilds } from "./build-script-approval.js";

const entry = { name: "@scope/package", version: "1.2.3-beta.1", integrity: "sha512-" + btoa("\0".repeat(64)) };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

it("decodes bounded exact blocked package identities", () => {
  expect(decodeBlockedBuilds(bytes([entry]))).toEqual([entry]);
  expect(decodeBlockedBuilds(bytes([]))).toEqual([]);
  for (const value of [[{ ...entry, approved: true }], [entry, entry], [{ ...entry, name: "../package" }],
    [{ ...entry, integrity: "sha512-bad" }], [{ ...entry, version: "latest" }], {}, Array.from({ length: 257 }, () => entry)]) {
    expect(() => decodeBlockedBuilds(bytes(value))).toThrow();
  }
  for (const value of [new Uint8Array(), new Uint8Array(65_537), new Uint8Array([255]), bytes("not a list")]) {
    expect(() => decodeBlockedBuilds(value)).toThrow();
  }
});
