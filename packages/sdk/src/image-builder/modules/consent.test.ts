import { describe, expect, it } from "vitest";
import { parseModuleSource } from "../../wasm/declaration.js";
import { authorityChange, authorityOf, consentCard } from "./consent.js";
import { buildReleaseFiles, sha } from "./release.test-support.js";
import { verifyRelease } from "./release.js";
import type { Resolution } from "./resolve.js";

const service = {
  process: { kind: "service", exclusive: "workspace" },
  expose: { sql: { kind: "unix", path: "/workspace/_oxidevm/db.sock", protocol: "db/1" }, pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" } },
  requires: { host: ["process.info", "files.sync"], browser: ["web-locks"], guest: { executables: ["/usr/bin/python3"] } },
  mounts: [{ guest: "/workspace", access: "rw" }],
  guestFiles: [{ artifact: "client.py", to: "/workspace/_oxidevm/py/client.py" }],
  state: { durable: ["/workspace/pgdata"] },
  license: { spdx: "GPL-2.0-only", source: "https://example.com/source" },
  options: { dataDir: { type: "string", maxLength: 64, default: "/workspace/pgdata" } },
};
const release = buildReleaseFiles({ id: "db", artifacts: { "client.py": new TextEncoder().encode("print()") }, extra: service });
const resolution = (source: Resolution["source"]): Resolution => ({ release: verifyRelease(release.manifestBytes, release.sumsBytes, [...release.files].filter(([name]) => name !== "module.json" && name !== "SHA256SUMS").map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.byteLength }))), source, paths: new Map() });

describe("what a module asks for", () => {
  it("lists every kind of authority as a sorted, de-duplicated string", () => {
    expect(authorityOf(release.manifest)).toEqual([
      "browser:web-locks", "durable:/workspace/pgdata", "guest-executable:/usr/bin/python3", "guest-file:/workspace/_oxidevm/py/client.py",
      "host:files.sync", "host:process.info", "listen:tcp:5432", "listen:unix:/workspace/_oxidevm/db.sock", "mount:rw:/workspace",
    ]);
    expect(authorityOf(buildReleaseFiles().manifest)).toEqual(["host:files.sync"]);
  });

  it("reports only what is new or gone, so a narrower release asks nothing", () => {
    const plain = buildReleaseFiles().manifest, wide = buildReleaseFiles({ host: ["files.sync", "process.spawn"] }).manifest;
    expect(authorityChange(undefined, plain)).toEqual({ added: ["host:files.sync"], removed: [] });
    expect(authorityChange(plain, wide)).toEqual({ added: ["host:process.spawn"], removed: [] });
    expect(authorityChange(wide, plain)).toEqual({ added: [], removed: ["host:process.spawn"] });
    expect(authorityChange(plain, plain)).toEqual({ added: [], removed: [] });
  });
});

describe("the consent card", () => {
  it("shows the declared authority, the license class and where the release came from", () => {
    const card = consentCard(resolution({ kind: "github", repository: "acme/db", tag: "v1.0.0", commit: "a".repeat(40), immutable: "yes", attested: "unknown" }), parseModuleSource("github:acme/db@v1.0.0"));
    expect(card).toMatchObject({
      id: "db", version: "1.0.0", source: "github:acme/db@v1.0.0", capabilities: ["files.sync", "process.info"], browser: ["web-locks"], guestExecutables: ["/usr/bin/python3"],
      mounts: ["rw /workspace"], guestFiles: ["/workspace/_oxidevm/py/client.py"], durablePaths: ["/workspace/pgdata"], options: ["dataDir"], minApi: 144,
      license: { spdx: "GPL-2.0-only", copyleft: true, source: "https://example.com/source" },
      signals: { commit: "a".repeat(40), immutable: "yes", attested: "unknown" },
    });
    expect(card.endpoints).toEqual(["pg: 127.0.0.1:5432 (postgres-3.0)", "sql: /workspace/_oxidevm/db.sock (db/1)"]);
  });

  it("has no GitHub signals for a local directory and classifies a permissive license as such", () => {
    const plain = buildReleaseFiles();
    const local: Resolution = { release: verifyRelease(plain.manifestBytes, plain.sumsBytes, [...plain.files].filter(([name]) => name !== "module.json" && name !== "SHA256SUMS").map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.byteLength }))), source: { kind: "file", path: "dist" }, paths: new Map() };
    const card = consentCard(local, { kind: "file", path: "dist" });
    expect(card.signals).toEqual({});
    expect(card.license.copyleft).toBe(false);
    expect(card.source).toBe("file:dist");
  });
});
