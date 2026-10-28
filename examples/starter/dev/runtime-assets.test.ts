import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { build } from "vite";
import { developmentAsset, runtimeAssets } from "./runtime-assets.ts";

it("serves development assets from the private cache and rejects paths or symlinks outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-dev-assets-"));
  try {
    await mkdir(join(root, "oxidevm/runtime"), { recursive: true }); await writeFile(join(root, "oxidevm/runtime/core.wasm"), "fixture");
    expect(await developmentAsset(root, "/oxidevm/runtime/core.wasm")).toBe(join(root, "oxidevm/runtime/core.wasm"));
    expect(await developmentAsset(root, "/oxidevm/../../secrets")).toBeUndefined();
    expect(await developmentAsset(root, "/oxidevm/%2e%2e/secrets")).toBeUndefined();
    expect(await developmentAsset(root, "/.oxidevm/starter.json")).toBeUndefined();
    await symlink(tmpdir(), join(root, "oxidevm/escape"));
    expect(await developmentAsset(root, "/oxidevm/escape/secret")).toBeUndefined();
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
    await mkdir(join(root, "public/oxidevm/runtime"), { recursive: true });
    await writeFile(join(root, "public/oxidevm/runtime/oxidevm_userspace.wasm"), "legacy engine cache");
    await expect(build({ root, configFile: false, logLevel: "silent", plugins: [runtimeAssets()] })).rejects.toThrow("Move development assets");
  } finally { await rm(root, { recursive: true, force: true }); }
});
