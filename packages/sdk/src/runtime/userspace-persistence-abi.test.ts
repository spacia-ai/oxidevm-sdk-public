import { describe, expect, it } from "vitest";
import { decodeUserspaceRootExport, decodeUserspaceWorkspaceExport, decodeUserspaceWorkspaceCapture } from "./userspace-persistence-abi.js";

function header(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("OXRP"));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setBigUint64(8, 3n, true);
  view.setBigUint64(16, 10_000_000_000n, true);
  view.setBigUint64(24, 42n, true);
  return bytes;
}

describe("bounded Userspace persistence ABI", () => {
  it("distinguishes cumulative delta and full capture records and rejects old schemas", () => {
    const bytes = header().slice(0, 24); bytes.set(new TextEncoder().encode("OXWP"));
    expect(() => decodeUserspaceWorkspaceCapture(bytes)).toThrow();
    bytes[4] = 2;
    expect(decodeUserspaceWorkspaceCapture(bytes)).toEqual({ id: 3n, bytes: 10_000_000_000, kind: "snapshot" });
    bytes[6] = 1;
    expect(decodeUserspaceWorkspaceCapture(bytes)).toEqual({ id: 3n, bytes: 10_000_000_000, kind: "delta" });
    bytes[6] = 2;
    expect(() => decodeUserspaceWorkspaceCapture(bytes)).toThrow();
  });
  it("decodes large workspace stream identity without a buffered-size assumption", () => {
    const bytes = header().slice(0, 24);
    bytes.set(new TextEncoder().encode("OXWP"));
    expect(decodeUserspaceWorkspaceExport(bytes)).toEqual({ id: 3n, bytes: 10_000_000_000 });
    for (const offset of [0, 4, 6, 8]) {
      const bad = bytes.slice(); bad[offset] = offset === 6 ? 1 : 0;
      expect(() => decodeUserspaceWorkspaceExport(bad)).toThrow();
    }
    for (let length = 0; length < bytes.length; length++) expect(() => decodeUserspaceWorkspaceExport(bytes.slice(0, length))).toThrow();
    expect(() => decodeUserspaceWorkspaceExport(new Uint8Array(25))).toThrow();
    for (const length of [0n, 11n, 1024n ** 4n + 1n]) {
      const bad = bytes.slice(); new DataView(bad.buffer).setBigUint64(16, length, true);
      expect(() => decodeUserspaceWorkspaceExport(bad)).toThrow();
    }
  });
  it("keeps token and revision identity exact and bounds stream lengths", () => {
    expect(decodeUserspaceRootExport(header())).toEqual({ id: 3n, bytes: 10_000_000_000, revision: 42n });
  });
  it.each([0, 4, 6, 8])("rejects bad magic, schema, flags or zero identity at %i", offset => {
    const bytes = header();
    bytes[offset] = offset === 6 ? 1 : 0;
    expect(() => decodeUserspaceRootExport(bytes)).toThrow();
  });
  it.each([0n, 1024n ** 4n + 1n])("rejects invalid stream length %s", length => {
    const bytes = header();
    new DataView(bytes.buffer).setBigUint64(16, length, true);
    expect(() => decodeUserspaceRootExport(bytes)).toThrow();
  });
  it("rejects truncated, trailing and exhausted-generation records", () => {
    expect(() => decodeUserspaceRootExport(header().slice(1))).toThrow();
    expect(() => decodeUserspaceRootExport(new Uint8Array(33))).toThrow();
    const bytes = header();
    new DataView(bytes.buffer).setBigUint64(24, 0xffff_ffff_ffff_ffffn, true);
    expect(() => decodeUserspaceRootExport(bytes)).toThrow();
  });
});
