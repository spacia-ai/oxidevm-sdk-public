import { chmod, lstat, mkdir, readlink, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { VMError } from "../runtime/errors.js";
import { collectRootfs, type SourceFileMetadata } from "./files.js";
import { encodeWorkspaceBaseline } from "./workspace-baseline.js";

/** Resolve guest symlinks under the staging root; host absolute links are never followed. */
async function directory(root: string, path: string, metadata: Map<string, SourceFileMetadata>): Promise<string> {
  let pending = path.split("/"); let resolved: string[] = []; let links = 0;
  while (pending.length !== 0) {
    const segment = pending.shift();
    if (segment === undefined || segment === "" || segment === ".") continue;
    if (segment === "..") { resolved.pop(); continue; }
    const relative = [...resolved, segment].join("/");
    const host = join(root, relative); const entry = await lstat(host).catch(() => undefined);
    if (entry?.isSymbolicLink() === true) {
      if (++links > 40) throw new VMError("INVALID_ARGUMENT", "managed integration directory has a guest symlink loop");
      const target = await readlink(host);
      if (posix.isAbsolute(target)) resolved = [];
      pending = [...target.split("/"), ...pending]; continue;
    }
    if (entry === undefined) {
      await mkdir(host); await chmod(host, 0o755);
      metadata.set(relative, { mode: 0o755, ownership: { uid: 0, gid: 0 } });
    } else if (!entry.isDirectory()) throw new VMError("INVALID_ARGUMENT", "managed integration parent is not a guest directory");
    resolved.push(segment);
  }
  return resolved.join("/");
}

export async function stageManagedIntegration(root: string, integration: {
  readonly agent: Uint8Array; readonly init: Uint8Array;
}, epoch: number, original: ReadonlyMap<string, SourceFileMetadata>, signal?: AbortSignal): Promise<ReadonlyMap<string, SourceFileMetadata>> {
  const metadata = new Map(original);
  const agent = await directory(root, "usr/libexec", metadata);
  const init = await directory(root, "sbin", metadata);
  const configuration = await directory(root, "usr/share/oxidevm", metadata);
  const workspace = await directory(root, "workspace", metadata);
  const baseline = `${configuration}/workspace-baseline`;
  const files = [
    { path: `${agent}/oxidevm-agent`, bytes: integration.agent, mode: 0o755 },
    { path: `${init}/oxidevm-init`, bytes: integration.init, mode: 0o755 },
    { path: `${configuration}/source-date-epoch`, bytes: new TextEncoder().encode(`${String(epoch)}\n`), mode: 0o644 },
  ];
  // Preflight every destination before changing any existing payload.
  for (const path of [...files.map(file => file.path), baseline]) {
    const existing = await lstat(join(root, path)).catch(() => undefined);
    if (existing !== undefined && !existing.isFile()) throw new VMError("INVALID_ARGUMENT", "managed integration destination must be a regular guest file");
  }
  for (const file of files) {
    await writeFile(join(root, file.path), file.bytes); await chmod(join(root, file.path), file.mode);
    metadata.set(file.path, { mode: file.mode, ownership: { uid: 0, gid: 0 } });
  }
  // Prepare the exact final guest metadata before boot, rather than hashing the workspace in x86.
  const tree = await collectRootfs(root, undefined, signal, metadata);
  await writeFile(join(root, baseline), encodeWorkspaceBaseline(tree.entries, tree.blobs, workspace, epoch));
  await chmod(join(root, baseline), 0o644);
  metadata.set(baseline, { mode: 0o644, ownership: { uid: 0, gid: 0 } });
  return metadata;
}
