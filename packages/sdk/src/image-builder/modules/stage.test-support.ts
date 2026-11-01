import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyRelease, type VerifiedRelease } from "./release.js";
import { sha, type BuiltRelease } from "./release.test-support.js";
import type { StageInput } from "./stage.js";

/** Writes a release's files to `source` and returns the verified release with where each file is. */
export async function releaseInput(release: BuiltRelease, source: string): Promise<StageInput> {
  const paths = new Map<string, string>();
  for (const [name, bytes] of release.files) { await writeFile(join(source, name), bytes); if (name !== "module.json" && name !== "SHA256SUMS") paths.set(name, join(source, name)); }
  const measured = [...release.files].filter(([name]) => name !== "module.json" && name !== "SHA256SUMS").map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.byteLength }));
  const verified: VerifiedRelease = verifyRelease(release.manifestBytes, release.sumsBytes, measured);
  return { release: verified, paths };
}
