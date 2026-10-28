import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRepositoryPolicy, repositoryContentError, repositoryEntryError, repositoryFileContentError } from "./repository-layout.ts";
import { createHash } from "node:crypto";

const policy = decodeRepositoryPolicy({ schemaVersion: 1, files: ["AGENTS.md", "CLAUDE.md", "package.json"], trees: ["packages/sdk/src/", "examples/hello-files/"] });

await test("licensed font assets require an exact path, WOFF2 header and immutable checksum", () => {
  const font = Buffer.alloc(48); font.write("wOF2"); font.writeUInt32BE(font.length, 8);
  const path = "examples/starter/public/fonts/archivo.woff2";
  const approved = decodeRepositoryPolicy({ schemaVersion: 2, files: [path, "fonts/OFL.txt"], trees: [], assets: { [path]: { sha256: createHash("sha256").update(font).digest("hex"), license: "fonts/OFL.txt" } } });
  assert.equal(repositoryFileContentError(approved, path, font), undefined);
  assert.ok(repositoryFileContentError(approved, path, Uint8Array.of(127, 69, 76, 70)) !== undefined);
  assert.ok(repositoryFileContentError(approved, "renamed.woff2", font) !== undefined);
  font[47] = 1;
  assert.ok(repositoryFileContentError(approved, path, font) !== undefined);
});

await test("renamed engine binaries cannot enter an approved source path", () => {
  assert.equal(repositoryContentError(Buffer.from("export const value = 1;\n")), undefined);
  assert.ok(repositoryContentError(Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 0)) !== undefined);
  assert.ok(repositoryContentError(Uint8Array.of(0xff, 0xfe)) !== undefined);
});

await test("repository policy rejects extra fields and escaping or duplicate paths", () => {
  for (const value of [
    { schemaVersion: 1, files: [], trees: [], extra: true },
    { schemaVersion: 1, files: ["../secret"], trees: [] },
    { schemaVersion: 1, files: ["package.json", "package.json"], trees: [] },
    { schemaVersion: 1, files: [], trees: ["packages"] },
  ]) assert.throws(() => decodeRepositoryPolicy(value));
});

await test("repository policy admits only its exact files and source trees", () => {
  assert.equal(repositoryEntryError(policy, "packages/sdk/src/vm.ts", "100644"), undefined);
  assert.equal(repositoryEntryError(policy, "examples/hello-files/build.sh", "100755"), undefined);
  for (const path of ["docs/plans/status.md", "packages/sdk/src/dist/output.js", "packages/sdk/src/engine.wasm", "examples/hello-files/.env", "examples/hello-files/.gitkeep", "../package.json", "/package.json"]) {
    assert.ok(repositoryEntryError(policy, path, "100644") !== undefined, path);
  }
});

await test("CLAUDE.md is the sole admitted symlink and must reference AGENTS.md", () => {
  assert.equal(repositoryEntryError(policy, "CLAUDE.md", "120000", "AGENTS.md"), undefined);
  assert.ok(repositoryEntryError(policy, "CLAUDE.md", "100644") !== undefined);
  assert.ok(repositoryEntryError(policy, "CLAUDE.md", "120000", "../AGENTS.md") !== undefined);
  assert.ok(repositoryEntryError(policy, "packages/sdk/src/link.ts", "120000", "../../private") !== undefined);
});
