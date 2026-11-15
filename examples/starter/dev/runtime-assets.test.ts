import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { build } from "vite";
import { developmentAsset, runtimeAssets } from "./runtime-assets.ts";

it("serves development assets from the private cache and rejects paths or symlinks outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-dev-assets-"));
  try {
    await mkdir(join(root, "oxvm/runtime"), { recursive: true }); await writeFile(join(root, "oxvm/runtime/core.wasm"), "fixture");
    expect(await developmentAsset(root, "/oxvm/runtime/core.wasm")).toBe(join(root, "oxvm/runtime/core.wasm"));
    expect(await developmentAsset(root, "/oxvm/../../secrets")).toBeUndefined();
    expect(await developmentAsset(root, "/oxvm/%2e%2e/secrets")).toBeUndefined();
    expect(await developmentAsset(root, "/.oxvm/starter.json")).toBeUndefined();
    await symlink(tmpdir(), join(root, "oxvm/escape"));
    expect(await developmentAsset(root, "/oxvm/escape/secret")).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("production builds retain license materials and refuse the old public engine cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-production-notices-"));
  try {
    await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');
    await writeFile(join(root, "main.js"), 'document.title = "fixture";');
    for (const file of ["LICENSE", "NOTICE", "LICENSES.md"]) await writeFile(join(root, file), `${file}: retained fixture notice`);
    await build({ root, configFile: false, logLevel: "silent", plugins: [runtimeAssets()] });
    expect(await readFile(join(root, "dist/licenses/SDK-LICENSE.txt"), "utf8")).toContain("Apache License");
    expect(await readFile(join(root, "dist/licenses/NOTICE.txt"), "utf8")).toBe("NOTICE: retained fixture notice");
    expect(await readFile(join(root, "dist/licenses/THIRD_PARTY_NOTICES.txt"), "utf8")).toContain("Unicode-DFS-2016");
    for (const directory of ["oxvm", "oxidevm"]) {
      const cache = join(root, "public", directory);
      await mkdir(join(cache, "runtime"), { recursive: true });
      await writeFile(join(cache, "runtime/oxidevm_userspace.wasm"), "engine cache");
      await expect(build({ root, configFile: false, logLevel: "silent", plugins: [runtimeAssets()] })).rejects.toThrow("Move development assets");
      await rm(cache, { recursive: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
