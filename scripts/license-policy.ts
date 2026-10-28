import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exactKeys, record, string } from "../packages/sdk/src/runtime/decode.ts";

/** Public exports retain the engine's exact policy bytes and their immutable source revision. */
export async function verifyLicensePolicy(root: string): Promise<string> {
  const bytes = await readFile(join(root, "config/license-policy-source.json"));
  if (bytes.length > 16 * 1024) throw new Error("License policy source exceeds its size bound");
  const value: unknown = JSON.parse(bytes.toString()), input = record(value, "canonical license policy source");
  exactKeys(input, ["schemaVersion", "engineSource", "files"]);
  if (input["schemaVersion"] !== 1 || !/^[a-f0-9]{40}$/u.test(string(input["engineSource"], "policy source revision")) || !Array.isArray(input["files"])) throw new Error("Invalid canonical license policy revision");
  const expected = new Set(["config/allowed-licenses.json", "config/allowed-tool-licenses.json", "config/allowed-guest-artifact-licenses.json"]);
  if (input["files"].length !== expected.size) throw new Error("Incomplete canonical license policies");
  for (const entry of Array.from<unknown>(input["files"])) {
    const file = record(entry, "policy file"); exactKeys(file, ["path", "sha256"]);
    const path = string(file["path"], "policy path"), digest = string(file["sha256"], "policy digest");
    if (!expected.delete(path) || !/^[a-f0-9]{64}$/u.test(digest) || !(await lstat(join(root, path))).isFile()) throw new Error("Invalid canonical license policy file");
    if (createHash("sha256").update(await readFile(join(root, path))).digest("hex") !== digest) throw new Error(`${path} differs from its canonical policy revision`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}
