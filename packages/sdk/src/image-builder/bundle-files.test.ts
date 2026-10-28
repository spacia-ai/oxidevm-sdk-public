import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { readBundleFile } from "./bundle-files.js";
import { verifyDecodedGzip } from "./bundle.js";
import { hash } from "./files.js";

it("rejects escaping bundle paths and bounded metadata reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-bundle-paths-"));
  try {
    await writeFile(join(root, "valid"), "1234"); await symlink("/etc/hostname", join(root, "escaped"));
    expect(new TextDecoder().decode(await readBundleFile(root, "valid", 4))).toBe("1234");
    await expect(readBundleFile(root, "valid", 3)).rejects.toThrow(/bound/u);
    await expect(readBundleFile(root, "escaped")).rejects.toThrow(/symlink/u);
    await expect(readBundleFile(root, "../elsewhere")).rejects.toThrow(/escapes/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("checks decompressed chunk size and hash rather than only its gzip envelope", () => {
  const bytes = new TextEncoder().encode("actual guest disk bytes"); const encoded = gzipSync(bytes);
  expect(() => verifyDecodedGzip(encoded, { bytes: bytes.length, sha256: hash(bytes) })).not.toThrow();
  expect(() => verifyDecodedGzip(encoded, { bytes: bytes.length - 1, sha256: hash(bytes) })).toThrow(/bound/u);
  expect(() => verifyDecodedGzip(encoded, { bytes: bytes.length, sha256: "0".repeat(64) })).toThrow(/identity/u);
});
