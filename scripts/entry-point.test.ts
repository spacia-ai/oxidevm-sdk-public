// scripts/entry-point.ts: whether a module is the program Node was started on. It must work on every Node 24;
// import.meta.main needs 24.2 and is undefined before, which would turn a script into a silent no-op.
// (`node --test scripts/entry-point.test.ts`)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const helper = resolve(import.meta.dirname, "entry-point.ts");

async function run(script: string): Promise<string> {
  return (await execute(process.execPath, [script], { encoding: "utf8" })).stdout;
}

await test("is true only for the module Node was started on, including through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-entry-point-test-"));
  try {
    const child = join(root, "child.mjs");
    await writeFile(child, `import { isEntryPoint } from ${JSON.stringify(helper)};\nprocess.stdout.write(\`child:\${String(isEntryPoint(import.meta.url))}\\n\`);\n`);
    const parent = join(root, "parent.mjs");
    await writeFile(parent, `import { isEntryPoint } from ${JSON.stringify(helper)};\nawait import(${JSON.stringify(child)});\nprocess.stdout.write(\`parent:\${String(isEntryPoint(import.meta.url))}\\n\`);\n`);
    assert.equal(await run(child), "child:true\n", "a module started directly is the entry point");
    assert.equal(await run(parent), "child:false\nparent:true\n", "an imported module is not, the module that imported it is");
    const link = join(root, "link.mjs");
    await symlink(parent, link);
    assert.equal(await run(link), "child:false\nparent:true\n", "a symlink to the entry module is the entry point");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("is false when Node was started without a script", async () => {
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", `import { isEntryPoint } from ${JSON.stringify(helper)};\nprocess.stdout.write(String(isEntryPoint("file:///nowhere/at-all.ts")));\n`], { encoding: "utf8" });
  assert.equal(stdout, "false");
});
