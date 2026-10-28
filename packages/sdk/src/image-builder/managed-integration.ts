import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { VMError } from "../runtime/errors.js";
import { readReleaseCatalog } from "./release-catalog.js";
import { downloadBundle } from "./download.js";
import { readBundleFile, verifyBundleArtifact } from "./bundle-files.js";
import { getSDKRelease } from "./project.js";

/** GPL guest/kernel integration stays in a separate pinned channel, never in npm. */
export async function loadManagedIntegration(signal?: AbortSignal): Promise<{ readonly kernel: Uint8Array<ArrayBuffer>; readonly agent: Uint8Array<ArrayBuffer>; readonly init: Uint8Array<ArrayBuffer> }> {
  const catalog = await readReleaseCatalog();
  if (catalog.sdkVersion !== getSDKRelease().sdkVersion) throw new VMError("PROTOCOL_ERROR", "guest integration belongs to another SDK release");
  const bootstrap = catalog.bootstrap;
  if (bootstrap === null) throw new VMError("FEATURE_NOT_AVAILABLE", "This SDK release requires a developer-supplied kernel and guest integration");
  const directory = join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "oxidevm/bootstrap", bootstrap.identity);
  const base = new URL("https://integration.invalid/manifest.json");
  const validate = async (root: string) => {
    for (const artifact of bootstrap.files) await verifyBundleArtifact(root, base, { ...artifact, url: new URL(artifact.name, base) }, signal);
  };
  if (await lstat(directory).catch(() => undefined) === undefined) await downloadBundle(bootstrap.archive, directory, validate, signal);
  await validate(directory);
  return { kernel: await readBundleFile(directory, "kernel", 128 * 1024 ** 2, signal), agent: await readBundleFile(directory, "agent", 128 * 1024 ** 2, signal), init: await readBundleFile(directory, "init", 64 * 1024, signal) };
}
