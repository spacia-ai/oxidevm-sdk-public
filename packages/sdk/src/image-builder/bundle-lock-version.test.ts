import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readImageBundle } from "./bundle.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(made => rm(made, { recursive: true, force: true })));
});

async function bundleWithLock(lock: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oxidevm-lock-version-"));
  directories.push(dir);
  await writeFile(join(dir, "image.lock.json"), `${JSON.stringify(lock)}\n`);
  return dir;
}

const CURRENT_FIELDS = {
  mode: "userspace",
  id: "sdk-alpine-smoke",
  version: "2026.10.14-rc.4",
  manifestUrl: "/oxidevm/images/sdk-alpine-smoke/manifest.json",
  manifestSHA256: "0".repeat(64),
  trust: { algorithm: "Ed25519", keyId: "key-0", publicKey: "AA==" },
  distribution: {},
  smokeTest: {},
  sourceIdentity: "0".repeat(64),
};

it("names the lock version it found and the fix when a bundle predates lock schema 2", async () => {
  const dir = await bundleWithLock({ schemaVersion: 1, ...CURRENT_FIELDS });

  const failure = await readImageBundle(dir).then(() => undefined, (error: unknown) => error);

  expect(failure).toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "image-lock-version", found: 1, supported: 2 },
  });
  expect(failure).toHaveProperty(
    "message",
    expect.stringMatching(/^unsupported image lock version .*older SDK.*update the SDK or rebuild the image/u),
  );
});

it("checks the lock version before its field set, so an older layout still gets the version error", async () => {
  const dir = await bundleWithLock({ schemaVersion: 1, mode: "userspace", id: "old" });

  await expect(readImageBundle(dir)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "image-lock-version", found: 1 },
  });
});

it("reports a non-numeric lock version as found null rather than echoing the value", async () => {
  const dir = await bundleWithLock({ ...CURRENT_FIELDS, schemaVersion: "2" });

  await expect(readImageBundle(dir)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "image-lock-version", found: null, supported: 2 },
  });
});
