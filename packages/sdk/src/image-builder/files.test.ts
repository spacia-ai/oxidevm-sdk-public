import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { checkedArtifact, collectRootfs, hash, verifyArtifact } from "./files.js";

it("admits package-manager documentation of PEM headers without admitting actual key material", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oxidevm-pem-documentation-"));
  try {
    await writeFile(join(dir, "definitions.js"), 'export const explanation = "-----BEGIN PRIVATE KEY-----";\n');
    await expect(collectRootfs(dir, undefined)).resolves.toMatchObject({ entries: [{ path: "definitions.js", type: "file" }] });
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });
    await writeFile(join(dir, "hidden.txt"), pem);
    await expect(collectRootfs(dir, undefined)).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { path: "hidden.txt" } });
    await writeFile(join(dir, "hidden.txt"), JSON.stringify({ privateKey: pem }));
    await expect(collectRootfs(dir, undefined)).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { path: "hidden.txt" } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("rejects an oversized boot input before allocating its bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oxidevm-artifact-limit-"));
  try {
    const file = await open(join(dir, "large"), "wx");
    try { await file.truncate(128 * 1024 ** 2 + 1); } finally { await file.close(); }
    await expect(checkedArtifact({ path: "large", sha256: "0".repeat(64) }, dir)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("rejects build-secret bytes copied into a rootfs without exposing them in error details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oxidevm-secret-payload-"));
  try {
    const secret = new TextEncoder().encode("known-private-mount-token");
    await writeFile(join(dir, "leaked"), Buffer.concat([Buffer.from("prefix"), secret, Buffer.from("suffix")]));
    await expect(collectRootfs(dir, undefined, undefined, undefined, [secret])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    try { await collectRootfs(dir, undefined, undefined, undefined, [secret]); }
    catch (error) { expect(JSON.stringify(error)).not.toContain("known-private-mount-token"); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("verifies a pinned regular archive with cancellation and rejects link substitution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oxidevm-artifact-pin-"));
  try {
    await writeFile(join(dir, "archive"), "source");
    const input = { path: "archive", sha256: hash("source") };
    await expect(verifyArtifact(input, dir)).resolves.toBeUndefined();
    await expect(verifyArtifact(input, dir, AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
    await expect(verifyArtifact({ ...input, sha256: hash("tampered") }, dir)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await symlink("archive", join(dir, "link"));
    await expect(verifyArtifact({ ...input, path: "link" }, dir)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
