import { mkdtemp, mkdir, readFile, rm, writeFile, link, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { c } from "tar";
import { afterEach, expect, it } from "vitest";
import { buildImage } from "./build.js";
import { inspectImage, readImageBundle } from "./bundle.js";
import { hashFile } from "./files.js";
import { generateImageKey } from "./keys.js";
import { record } from "../runtime/decode.js";
import { decodeUserspaceRootfsManifest, encodeUserspaceRootfsMetadata } from "../runtime/userspace-rootfs.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
/** The Userspace runtime's default credentials, which own a Userspace workspace unless the recipe names another owner. */
const defaultUser = { uid: 1000, gid: 1000 };

it("builds a pinned signed development image, preserves hardlinks and detects tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-builder-")); directories.push(directory);
  const root = join(directory, "root"); await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace/a"), "42"); await link(join(root, "workspace/a"), join(root, "workspace/b"));
  const key = await generateImageKey(join(directory, "author.pem"));
  expect((await stat(key.privateKeyPath)).mode & 0o777).toBe(0o600);
  const recipe = { id: "python", version: "1", mode: "userspace" as const, sourceDateEpoch: 123, source: { kind: "directory" as const, path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 as const } };
  const built = await buildImage(recipe, { recipeDir: directory, signingKeyFile: key.privateKeyPath, publicBaseUrl: "/images/python/1/" });
  expect(built.mode).toBe("userspace"); expect(built.distribution.kind).toBe("development");
  const inspection = await inspectImage(built.bundleDir, { trust: key.trust });
  expect(inspection.authentication).toEqual({ kind: "verified", keyId: key.trust.keyId });
  const value: unknown = JSON.parse(await readFile(built.manifestPath, "utf8")) as unknown;
  const manifest = record(value, "test manifest");
  expect(manifest["schemaVersion"]).toBe(8); expect(manifest["runtimes"]).toMatchObject({ supportingFiles: [] });
  const entries = manifest["entries"]; if (!Array.isArray(entries)) throw new Error("manifest entries are missing");
  expect(Array.from<unknown>(entries)).toContainEqual({ type: "hardlink", path: "workspace/b", target: "workspace/a", mode: (await stat(join(root, "workspace/b"))).mode & 0o7777, ownership: defaultUser, times: { accessNs: "123000000000", modificationNs: "123000000000" } });
  const metadata = encodeUserspaceRootfsMetadata(decodeUserspaceRootfsManifest(value, new URL("https://images.example/manifest.json")));
  const view = new DataView(metadata.buffer);
  expect(view.getUint16(4, true)).toBe(8);
  expect(view.getBigInt64(32, true)).toBe(123_000_000_000n);
  expect(view.getBigInt64(40, true)).toBe(123_000_000_000n);
  const rebuilt = await buildImage(recipe, { recipeDir: directory, signingKeyFile: key.privateKeyPath, publicBaseUrl: "/images/python/1/" });
  expect(rebuilt.image.manifestSHA256).toBe(built.image.manifestSHA256);
  await writeFile(built.manifestPath, "{}"); await expect(inspectImage(built.bundleDir, { trust: key.trust })).rejects.toThrow(/digest/u);
});

it("does not overwrite keys and fails distribution builds with missing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-key-")); directories.push(directory);
  const path = join(directory, "author.pem"); const key = await generateImageKey(path); const bytes = await readFile(path);
  await expect(generateImageKey(path)).rejects.toThrow(); expect(await readFile(path)).toEqual(bytes);
  await mkdir(join(directory, "root"));
  await expect(buildImage({ id: "test", version: "1", mode: "userspace", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: directory, signingKeyFile: key.privateKeyPath, purpose: "distribution" })).rejects.toThrow(/evidence/u);
});

it("uses immutable manifest URLs, the image ID filename and a persisted epoch before building", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-builder-defaults-")); directories.push(directory);
  await mkdir(join(directory, "root")); await writeFile(join(directory, "root/value"), "owned bytes");
  const key = await generateImageKey(join(directory, "author.pem"));
  const recipe = { id: "defaults", version: "1", mode: "userspace" as const, source: { kind: "directory" as const, path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 as const } };
  let observedEpoch: unknown;
  const built = await buildImage(recipe, { recipeDir: directory, signingKeyFile: key.privateKeyPath, onProgress: event => {
    if (event.phase === "build-rootfs") observedEpoch = record(JSON.parse(readFileSync(join(directory, "image.lock.json"), "utf8")) as unknown, "input lock")["sourceDateEpoch"];
  } });
  expect(built.image.manifestUrl).toBe(`/oxidevm/images/defaults/${built.image.manifestSHA256}/manifest.json`);
  expect(basename(built.referencePath)).toBe("defaults.image.ts");
  const manifest = record(JSON.parse(await readFile(built.manifestPath, "utf8")) as unknown, "built manifest");
  expect(observedEpoch).toBe(manifest["sourceDateEpoch"]);
  const lock = record(JSON.parse(await readFile(join(directory, "image.lock.json"), "utf8")) as unknown, "persisted lock");
  expect(lock["sourceDateEpoch"]).toBe(observedEpoch);
  expect((await buildImage(recipe, { recipeDir: directory, signingKeyFile: key.privateKeyPath })).image.manifestSHA256).toBe(built.image.manifestSHA256);
});
it("writes bundle image locks of schema 2 and refuses schema 1 before reading the bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-image-lock-")); directories.push(directory);
  await mkdir(join(directory, "root")); await writeFile(join(directory, "root/value"), "owned bytes");
  const key = await generateImageKey(join(directory, "author.pem"));
  const built = await buildImage({ id: "locked", version: "1", mode: "userspace", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: directory, signingKeyFile: key.privateKeyPath });
  const lock = record(JSON.parse(await readFile(built.lockPath, "utf8")) as unknown, "image lock");
  expect(lock["schemaVersion"]).toBe(2);
  await writeFile(built.lockPath, JSON.stringify({ ...lock, schemaVersion: 1 }));
  await expect(readImageBundle(built.bundleDir)).rejects.toThrow("unsupported image lock version");
});
it("signs the recipe's process recommendation rather than silently dropping it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-process-recommendation-")); directories.push(directory);
  await mkdir(join(directory, "root"));
  const key = await generateImageKey(join(directory, "author.pem"));
  const built = await buildImage({ id: "limited", version: "1", mode: "userspace", source: { kind: "directory", path: "root" }, resources: { memoryMiB: 256, maxProcesses: 8 }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: directory, signingKeyFile: key.privateKeyPath });
  const manifest = record(JSON.parse(await readFile(built.manifestPath, "utf8")) as unknown, "manifest");
  expect(manifest["resources"]).toEqual({ memoryMiB: 256, maxProcesses: 8 });
  expect((await inspectImage(built.bundleDir, { trust: key.trust })).authentication.kind).toBe("verified");
});
it("rejects concurrent builds sharing an author lock and releases it after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-concurrent-build-")); directories.push(directory);
  await mkdir(join(directory, "root")); await writeFile(join(directory, "root/value"), "source bytes");
  const key = await generateImageKey(join(directory, "author.pem"));
  const recipe = { id: "shared", version: "1", mode: "userspace" as const, source: { kind: "directory" as const, path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 as const } };
  const results = await Promise.allSettled(["first", "second"].map(outDir => buildImage(recipe, { recipeDir: directory, signingKeyFile: key.privateKeyPath, outDir })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected");
  expect(rejected?.status === "rejected" ? rejected.reason as unknown : null).toMatchObject({ code: "STORAGE_ERROR" });
  const next = await buildImage(recipe, { recipeDir: directory, signingKeyFile: key.privateKeyPath, outDir: "subsequent" });
  expect((await inspectImage(next.bundleDir, { trust: key.trust })).authentication.kind).toBe("verified");
});
it("rejects unused secret mounts on sources that do not use BuildKit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-unused-secret-")); directories.push(directory);
  await mkdir(join(directory, "root")); await writeFile(join(directory, "credential"), "private-author-token");
  const key = await generateImageKey(join(directory, "author.pem"));
  await expect(buildImage({ id: "unused", version: "1", mode: "userspace", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } },
    { recipeDir: directory, signingKeyFile: key.privateKeyPath, secrets: [{ id: "registry", file: "credential" }] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

it.each(["smokeTest", "sourceIdentity", "distribution", "buildInputs", "unknown-input"])("rejects an unsigned lock's changed %s even when the manifest is authentic", async field => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-signed-build-inputs-")); directories.push(directory);
  await mkdir(join(directory, "root")); await writeFile(join(directory, "root/value"), "owned bytes");
  const key = await generateImageKey(join(directory, "author.pem"));
  const built = await buildImage({ id: "locked", version: "1", mode: "userspace", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: directory, signingKeyFile: key.privateKeyPath });
  const lock = { ...record(JSON.parse(await readFile(built.lockPath, "utf8")) as unknown, "test lock") };
  if (field === "smokeTest") lock[field] = { command: "/bin/sh", args: ["-c", "unreviewed"], expectedExitCode: 0 };
  else if (field === "sourceIdentity") lock[field] = "unrelated source";
  else if (field === "distribution") lock[field] = { kind: "candidate", browserTestsRequired: true };
  else if (field === "buildInputs") lock[field] = { kind: "directory", sourceSHA256: "a".repeat(64) };
  else lock["buildInputs"] = { ...record(lock["buildInputs"], "build inputs"), extra: "unknown" };
  await writeFile(built.lockPath, JSON.stringify(lock));
  await expect(inspectImage(built.bundleDir, { trust: key.trust })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});

/** A pinned rootfs archive that records every entry, the workspace included, as owned by root. */
async function rootOwnedArchive(directory: string): Promise<{ readonly path: string; readonly sha256: string }> {
  const tree = join(directory, "tree");
  for (const path of ["etc", "workspace/app", "workspace-seed"]) await mkdir(join(tree, path), { recursive: true });
  await writeFile(join(tree, "etc/hostname"), "oxidevm\n"); await writeFile(join(tree, "workspace-seed/README"), "seed\n");
  await writeFile(join(tree, "workspace/app/index.js"), "export {};\n");
  await c({ file: join(directory, "rootfs.tar"), cwd: tree, jobs: 1, noMtime: true, onWriteEntry(entry) {
    if (entry.stat === undefined) throw new Error("archive entry has no stat");
    entry.stat.uid = 0; entry.stat.gid = 0;
  } }, ["etc", "workspace", "workspace-seed"]);
  return { path: "rootfs.tar", sha256: await hashFile(join(directory, "rootfs.tar")) };
}
it.each([
  { owner: "the runtime's default user", workspace: undefined, expected: defaultUser },
  { owner: "the recipe's explicit owner", workspace: { ownership: { uid: 1234, gid: 5678 } }, expected: { uid: 1234, gid: 5678 } },
])("signs a root-owned Userspace workspace as owned by $owner and keeps every other recorded owner", async ({ workspace, expected }) => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-workspace-owner-")); directories.push(directory);
  const key = await generateImageKey(join(directory, "author.pem"));
  const built = await buildImage({ id: "owned", version: "1", mode: "userspace", source: { kind: "archive", artifact: await rootOwnedArchive(directory) },
    ...(workspace === undefined ? {} : { workspace }), smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: directory, signingKeyFile: key.privateKeyPath });
  const manifest = decodeUserspaceRootfsManifest(JSON.parse(await readFile(built.manifestPath, "utf8")) as unknown, new URL("https://images.example/manifest.json"));
  const root = { uid: 0, gid: 0 };
  expect(Object.fromEntries(manifest.entries.map(entry => [entry.path, entry.ownership]))).toEqual({ etc: root, "etc/hostname": root,
    workspace: expected, "workspace-seed": root, "workspace-seed/README": root, "workspace/app": expected, "workspace/app/index.js": expected });
  // The signed tree and workspace identities are computed from the recorded owners.
  expect((await inspectImage(built.bundleDir, { trust: key.trust })).authentication.kind).toBe("verified");
});
it.each([["etc/shared", "workspace/shared"], ["workspace/shared", "zz/shared"]])("rejects a Userspace hardlink from %s to %s across the separately mounted workspace", async (first, second) => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-workspace-link-")); directories.push(directory);
  const root = join(directory, "root");
  for (const path of [first, second]) await mkdir(join(root, dirname(path)), { recursive: true });
  await writeFile(join(root, first), "shared bytes"); await link(join(root, first), join(root, second));
  const key = await generateImageKey(join(directory, "author.pem"));
  await expect(buildImage({ id: "linked", version: "1", mode: "userspace", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } },
    { recipeDir: directory, signingKeyFile: key.privateKeyPath })).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { path: second } });
});
