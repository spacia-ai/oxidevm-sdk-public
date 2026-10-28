import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyLicensePolicy } from "./license-policy.ts";

await test("copied license policies cannot change without a new canonical revision and digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-policy-"));
  try {
    await mkdir(join(root, "config"));
    const files = ["allowed-licenses.json", "allowed-tool-licenses.json", "allowed-guest-artifact-licenses.json"].map(name => ({ path: `config/${name}`, sha256: createHash("sha256").update("[]\n").digest("hex") }));
    for (const file of files) await writeFile(join(root, file.path), "[]\n");
    await writeFile(join(root, "config/license-policy-source.json"), JSON.stringify({ schemaVersion: 1, engineSource: "a".repeat(40), files }));
    await assert.doesNotReject(verifyLicensePolicy(root));
    await writeFile(join(root, "config/allowed-licenses.json"), '["GPL-2.0-only"]\n');
    await assert.rejects(verifyLicensePolicy(root), /canonical/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
