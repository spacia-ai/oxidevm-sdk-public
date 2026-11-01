import { describe, expect, it } from "vitest";
import { VMError } from "../runtime/errors.js";
import { decodeModulesLock, decodeModulesLockBytes, encodeModulesLock } from "./lock.js";

const sha = (character: string) => character.repeat(64);
const github = { kind: "github", repository: "spacia-ai/oxidevm-pglite", tag: "v0.1.0", commit: "b".repeat(40), immutable: "unknown", attested: "no" };
const locked = {
  source: github,
  version: "0.1.0",
  manifestSha256: sha("1"),
  adapter: { sha256: sha("2"), bytes: 4096 },
  artifacts: [{ name: "pglite.wasm", sha256: sha("3"), bytes: 9_087_748 }, { name: "client.py", sha256: sha("4"), bytes: 120 }],
  capabilities: ["process.info", "files.sync"],
  release: sha("5"),
};

describe("oxidevm.modules.lock.json", () => {
  it("sorts modules and capabilities and round-trips through canonical bytes without timestamps", () => {
    const lock = decodeModulesLock({ schemaVersion: 1, modules: { pyodide: { ...locked, source: { kind: "file", path: "modules/pyodide" } }, pglite: locked } });
    expect(Object.keys(lock.modules)).toEqual(["pglite", "pyodide"]);
    expect(lock.modules["pglite"]?.capabilities).toEqual(["files.sync", "process.info"]);
    const bytes = encodeModulesLock(lock);
    expect(decodeModulesLockBytes(bytes)).toEqual(lock);
    expect(new TextDecoder().decode(bytes)).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    expect(encodeModulesLock(decodeModulesLockBytes(bytes))).toEqual(bytes);
  });

  it("records signals GitHub may not expose as an explicit tri-state", () => {
    for (const state of ["yes", "no", "unknown"]) {
      expect(() => decodeModulesLock({ schemaVersion: 1, modules: { pglite: { ...locked, source: { ...github, immutable: state } } } })).not.toThrow();
    }
    expect(() => decodeModulesLock({ schemaVersion: 1, modules: { pglite: { ...locked, source: { ...github, immutable: true } } } })).toThrow(VMError);
  });

  it("rejects non-canonical bytes and every malformed field with a stable reason", () => {
    const base = { schemaVersion: 1, modules: { pglite: locked } };
    expect(() => decodeModulesLockBytes(new TextEncoder().encode(JSON.stringify(base)))).toThrow(VMError);
    const cases: readonly unknown[] = [
      { ...base, schemaVersion: 2 },
      { ...base, extra: true },
      { schemaVersion: 1, modules: { Bad: locked } },
      { schemaVersion: 1, modules: { pglite: { ...locked, extra: 1 } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, manifestSha256: "abc" } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, release: sha("z") } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, version: "1" } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, source: { ...github, commit: "abc" } } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, source: { ...github, repository: "no-owner" } } } },
      // `.` and `..` would walk out of the API path repos/<owner>/<repo>.
      ...["acme/.", "acme/.."].map(repository => ({ schemaVersion: 1, modules: { pglite: { ...locked, source: { ...github, repository } } } })),
      { schemaVersion: 1, modules: { pglite: { ...locked, source: { kind: "file", path: "../x" } } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, capabilities: ["files.syncc"] } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, capabilities: ["files.sync", "files.sync"] } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, artifacts: [locked.artifacts[0], locked.artifacts[0]] } } },
      { schemaVersion: 1, modules: { pglite: { ...locked, adapter: { sha256: sha("2"), bytes: -1 } } } },
      ...[".", "..", ".hidden", "a/b", "module.json", "adapter.mjs", "SHA256SUMS"].map(name => ({ schemaVersion: 1, modules: { pglite: { ...locked, artifacts: [{ name, sha256: sha("3"), bytes: 1 }] } } })),
    ];
    for (const value of cases) {
      expect(() => decodeModulesLock(value)).toThrow(VMError);
      try { decodeModulesLock(value); } catch (error: unknown) { expect(error).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } }); }
    }
  });
});
