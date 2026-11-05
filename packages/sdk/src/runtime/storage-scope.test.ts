import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decodeStorageScope,
  embedderStorage,
  encodeStorageScope,
  inStorageScope,
  ORIGIN_STORAGE,
  storageDirectoryName,
  storageName,
  type StorageScope,
} from "./storage-scope.js";

function expectedId(origin: string): string {
  return createHash("sha256").update(origin).digest("hex").slice(0, 32);
}

function id(scope: StorageScope): string {
  if (scope.kind !== "embedder") throw new Error("expected an embedder scope");
  return scope.id;
}

describe("storage scopes", () => {
  it("keeps the names a self-hosted page has always used", () => {
    expect(storageDirectoryName(ORIGIN_STORAGE)).toBe("oxidevm");
    expect(storageName(ORIGIN_STORAGE, "workspace-notes")).toBe("oxidevm-workspace-notes");
    expect(storageName(ORIGIN_STORAGE, "local-data")).toBe("oxidevm-local-data");
    expect(encodeStorageScope(ORIGIN_STORAGE)).toEqual({});
    expect(decodeStorageScope(undefined)).toEqual(ORIGIN_STORAGE);
  });

  it("gives every embedding origin of one site a scope of its own", async () => {
    // Browsers partition the runtime frame by top-level site, so these four would share one store.
    const origins = ["https://inboard.oxidevm.dev", "https://lab.oxidevm.dev", "http://localhost:5190", "http://localhost:5182"];
    const scopes = await Promise.all(origins.map(embedderStorage));
    expect(scopes.map(id)).toEqual(origins.map(expectedId));
    expect(new Set(scopes.map(storageDirectoryName)).size).toBe(origins.length);
    expect(new Set(scopes.map(scope => storageName(scope, "workspace-notes"))).size).toBe(origins.length);
    expect(storageDirectoryName(scopes[0] ?? ORIGIN_STORAGE)).toBe(`oxidevm-embedder-${expectedId(origins[0] ?? "")}`);
  });

  it("never counts another scope's names as its own", async () => {
    const a = await embedderStorage("https://a.example.com");
    const b = await embedderStorage("https://b.example.com");
    expect(inStorageScope(a, storageName(a, "workspace-x"))).toBe(true);
    expect(inStorageScope(a, storageName(b, "workspace-x"))).toBe(false);
    expect(inStorageScope(a, storageName(ORIGIN_STORAGE, "workspace-x"))).toBe(false);
    expect(inStorageScope(ORIGIN_STORAGE, storageName(a, "workspace-x"))).toBe(false);
    expect(inStorageScope(ORIGIN_STORAGE, "oxidevm-workspace-x")).toBe(true);
    expect(inStorageScope(ORIGIN_STORAGE, "someone-elses-database")).toBe(false);
  });

  it("carries an embedder scope across a worker boundary and rejects anything else", async () => {
    const scope = await embedderStorage("https://a.example.com");
    expect(decodeStorageScope(encodeStorageScope(scope).storage)).toEqual(scope);
    for (const malformed of ["", "0".repeat(31), "0".repeat(33), "G".repeat(32), "A".repeat(32), 7, null, {}]) {
      expect(() => decodeStorageScope(malformed)).toThrow(expect.objectContaining({ code: "PROTOCOL_ERROR" }));
    }
  });

  it("accepts only a serialized origin", async () => {
    for (const malformed of ["https://a.example.com/", "https://a.example.com/path", "null", "not a url", ""]) {
      await expect(embedderStorage(malformed)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    }
  });
});
