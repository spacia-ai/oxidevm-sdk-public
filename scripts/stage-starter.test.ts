import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { stageStarter } from "./stage-starter.ts";
import { record, string } from "../packages/sdk/src/runtime/decode.ts";

void test("generated starter documentation uses its own release and only existing local links", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-starter-docs-"));
  try {
    const source = resolve(import.meta.dirname, "..");
    await cp(join(source, "examples/starter"), join(root, "examples/starter"), { recursive: true, filter: path => !["node_modules", "dist", ".cache"].includes(basename(path)) });
    await mkdir(join(root, "packages/sdk"), { recursive: true });
    for (const version of ["0.0.5", "0.0.6"]) {
      await writeFile(join(root, "packages/sdk/package.json"), JSON.stringify({ version }));
      await stageStarter(root);
      const value: unknown = JSON.parse(await readFile(join(root, "packages/cli/dist/starter.json"), "utf8"));
      const files = record(value, "starter files"), readme = string(files["README.md"], "starter README");
      const release = "https://github.com/spacia-ai/oxidevm-sdk-public";
      assert(readme.includes(`${release}/tree/v${version}/examples/starter/image`));
      assert(readme.includes(`${release}/blob/v${version}/docs/images.md`));
      assert(!readme.includes("/blob/main/") && !readme.includes("/tree/main/"));
      assert(!Object.keys(files).some(path => path.startsWith("image/")));
      assert.match(readme, /do not include.*image.*directory/iu);
      // LICENSES.md is written by initializeApplication, after the staged files.
      const generated = new Set([...Object.keys(files), "LICENSES.md"]);
      for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const link = match[1]; assert(link !== undefined);
        if (/^(?:https?:|#)/u.test(link)) continue;
        const target = resolve(root, link.split("#")[0] ?? "");
        assert(generated.has(target.slice(root.length + 1)), `Missing generated README target: ${link}`);
      }
      for (const client of [".agents", ".claude"]) {
        const skill = string(files[`${client}/skills/oxidevm-starter/SKILL.md`], "starter skill");
        assert.match(skill, /README\.md/u);
        assert.match(skill, /release-pinned/u);
        assert.match(skill, /do not include.*image.*directory/iu);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
