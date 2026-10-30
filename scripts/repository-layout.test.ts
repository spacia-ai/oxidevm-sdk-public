import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

await test("root instructions preserve the exact CLAUDE.md symlink", () => {
  assert.equal(repositoryEntryError(policy, "CLAUDE.md", "120000", "AGENTS.md"), undefined);
  assert.ok(repositoryEntryError(policy, "CLAUDE.md", "100644") !== undefined);
  assert.ok(repositoryEntryError(policy, "CLAUDE.md", "120000", "../AGENTS.md") !== undefined);
  assert.ok(repositoryEntryError(policy, "packages/sdk/src/link.ts", "120000", "../../private") !== undefined);
});

await test("the reviewed starter Claude alias cannot escape the canonical skill snapshot", () => {
  const path = "examples/starter/.claude/skills";
  const approved = { ...policy, files: [...policy.files, path] };
  assert.equal(repositoryEntryError(approved, path, "120000", "../.agents/skills"), undefined);
  assert.ok(repositoryEntryError(approved, path, "120000", "../../../private") !== undefined);
  assert.ok(repositoryEntryError(approved, path, "100644") !== undefined);
  assert.ok(repositoryEntryError(approved, "examples/starter/.claude/settings.json", "100644") !== undefined);
});

await test("the exact reviewed favicon is admitted without allowing other PNGs or renamed binaries", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = "examples/starter/public/favicon.png";
  const icon = await readFile(new URL("../examples/starter/public/favicon.png", import.meta.url));
  const approved = (bytes: Uint8Array) => decodeRepositoryPolicy({ schemaVersion: 2, files: [path, "LICENSE"], trees: [], assets: { [path]: { sha256: createHash("sha256").update(bytes).digest("hex"), license: "LICENSE" } } });
  const policy = approved(icon);
  assert.equal(repositoryFileContentError(policy, path, icon), undefined);
  const changed = Buffer.from(icon); changed[changed.length - 1] = 1;
  assert.ok(repositoryFileContentError(policy, path, changed) !== undefined);
  const elf = Buffer.alloc(48); elf.set([127, 69, 76, 70]);
  assert.ok(repositoryFileContentError(approved(elf), path, elf) !== undefined);
  assert.ok(repositoryFileContentError(policy, "other.png", icon) !== undefined);
  assert.throws(() => decodeRepositoryPolicy({ schemaVersion: 2, files: ["other.png", "LICENSE"], trees: [], assets: { "other.png": { sha256: createHash("sha256").update(icon).digest("hex"), license: "LICENSE" } } }));
});

await test("a Git export validates the reviewed starter alias and rejects retargeting", async () => {
  const { mkdtemp, mkdir, rm, symlink, writeFile } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const { checkRepositoryLayout } = await import("./repository-layout.ts");
  const root = await mkdtemp(join(tmpdir(), "oxidevm-skill-layout-"));
  try {
    await mkdir(join(root, "config"));
    await mkdir(join(root, "examples/starter/.claude"), { recursive: true });
    const files = ["AGENTS.md", "CLAUDE.md", "LICENSE", "NOTICE", "config/public-repository.json", "examples/starter/.claude/skills"];
    for (const name of ["AGENTS.md", "LICENSE", "NOTICE"]) await writeFile(join(root, name), "fixture");
    await writeFile(join(root, "config/public-repository.json"), JSON.stringify({ schemaVersion: 1, files, trees: [] }));
    await symlink("AGENTS.md", join(root, "CLAUDE.md"));
    const alias = join(root, "examples/starter/.claude/skills");
    await symlink("../.agents/skills", alias);
    execFileSync("git", ["init", "--quiet", root]); execFileSync("git", ["-C", root, "add", "."]);
    await checkRepositoryLayout(root);
    await rm(alias); await symlink("../../../../.env", alias);
    await assert.rejects(checkRepositoryLayout(root), /canonical project skills/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
