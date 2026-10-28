import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseSecretScanArguments, scanSecrets } from "./secret-scan.ts";
import { createTLSTestIdentity } from "../packages/sdk/src/runtime/workers/assistance/tls-test-identity.test-support.ts";

await test("directory scanning admits dummy PEM text but rejects a real key at the same fixture path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-scanner-fixture-"));
  const root = resolve(import.meta.dirname, ".."), fixture = "packages/sdk/src/image-builder/docker-context.test.ts";
  try {
    await mkdir(join(directory, "packages/sdk/src/image-builder"), { recursive: true });
    await writeFile(join(directory, fixture), await readFile(join(root, fixture)));
    await scanSecrets(directory, "dir", root);
    await writeFile(join(directory, fixture), (await createTLSTestIdentity()).key, { mode: 0o600 });
    await assert.rejects(scanSecrets(directory, "dir", root));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

await test("secret scanner accepts only a bounded Git or directory target", () => {
  assert.deepEqual(parseSecretScanArguments([]), { kind: "git", directory: "." });
  assert.deepEqual(parseSecretScanArguments(["dir", "candidate"]), { kind: "dir", directory: "candidate" });
  for (const args of [["unknown"], ["git", "--help"], ["dir", ""], ["dir", "x", "extra"]]) assert.throws(() => parseSecretScanArguments(args));
});
