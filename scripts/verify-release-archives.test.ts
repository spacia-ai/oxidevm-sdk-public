import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReleaseArchive } from "./verify-release-archives.ts";

await test("archives remain private and separate compiler assets from engine or guest binaries", () => {
  const manifest = { name: "@oxidevm/sdk", version: "0.0.1", private: true, dependencies: {} };
  const files = ["package/LICENSE", "package/NOTICE", "package/dist/index.js", "package/assets/compilers/esbuild.wasm"];
  assert.doesNotThrow(() => validateReleaseArchive(manifest, files, "@oxidevm/sdk", "0.0.1"));
  for (const extra of ["package/oxidevm_core.wasm", "package/assets/images/rootfs.img", "package/author.key", "../escape", "package/.env"]) assert.throws(() => validateReleaseArchive(manifest, [...files, extra], "@oxidevm/sdk", "0.0.1"));
  assert.throws(() => validateReleaseArchive({ ...manifest, private: false }, files, "@oxidevm/sdk", "0.0.1"));
  const publicManifest = { ...manifest, private: false, publishConfig: { registry: "https://registry.npmjs.org/", access: "public" } };
  assert.doesNotThrow(() => validateReleaseArchive(publicManifest, files, "@oxidevm/sdk", "0.0.1", "public"));
  assert.throws(() => validateReleaseArchive({ ...publicManifest, publishConfig: { registry: "http://127.0.0.1:4873/", access: "public" } }, files, "@oxidevm/sdk", "0.0.1", "public"));
  assert.throws(() => validateReleaseArchive({ ...manifest, publishConfig: { registry: "https://registry.npmjs.org" } }, files, "@oxidevm/sdk", "0.0.1"));
  assert.throws(() => validateReleaseArchive({ ...manifest, dependencies: { bad: "workspace:*" } }, files, "@oxidevm/sdk", "0.0.1"));
  assert.throws(() => validateReleaseArchive({ ...manifest, name: "@oxidevm/cli", dependencies: { "@oxidevm/sdk": "0.0.2" } }, files, "@oxidevm/cli", "0.0.1"));
});
