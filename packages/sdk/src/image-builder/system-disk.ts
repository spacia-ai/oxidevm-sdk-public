import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VMError } from "../runtime/errors.js";
import { userspaceTreeIdentity } from "../runtime/userspace-rootfs.js";
import type { UserspaceRootfsEntry } from "../runtime/userspace-rootfs.js";
import { collectRootfs } from "./files.js";
import type { SourceFileMetadata } from "./files.js";
import { runTool } from "./tools.js";

/** Fixed filesystem entropy and every inode timestamp are part of reproducible bytes. */
export async function createRootfsDisk(options: {
  readonly root: string; readonly diskPath: string; readonly staging: string;
  readonly entries: readonly UserspaceRootfsEntry[]; readonly sizeMiB: number;
  readonly sourceDateEpoch: number; readonly signal?: AbortSignal;
}): Promise<void> {
  const env = { ...process.env, E2FSPROGS_FAKE_TIME: String(options.sourceDateEpoch) };
  const uuid = "bbf0e552-b673-4e8c-8c76-0a4785f66d01";
  await runTool("mke2fs", ["-q", "-t", "ext4", "-b", "4096", "-U", uuid, "-E",
    `hash_seed=${uuid},lazy_itable_init=0,lazy_journal_init=0`, "-d", options.root, options.diskPath, String(options.sizeMiB * 256)],
  { env, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  await writeDiskMetadata(options.diskPath, options.entries, options.staging, options.signal, options.sourceDateEpoch);
}

export function debugfsArgument(path: string): string {
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) throw new VMError("INVALID_ARGUMENT", "ext4 input path contains a control character");
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Read-only extraction through e2fsprogs; reuse the existing schema-3 workspace identity. */
export async function workspaceIdentityFromDisk(disk: string, signal?: AbortSignal): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), "oxidevm-disk-workspace-"));
  try {
    await runTool("debugfs", ["-R", `rdump /workspace ${debugfsArgument(staging)}`, disk], signal === undefined ? {} : { signal });
    const workspace = join(staging, "workspace");
    if ((await stat(workspace).catch(() => undefined))?.isDirectory() !== true) throw new VMError("INVALID_ARGUMENT", "managed disk has no /workspace directory");
    const tree = await collectRootfs(workspace, undefined, signal);
    const modes = await diskModes(disk, tree.entries.map(entry => `/workspace/${entry.path}`), staging, signal);
    const files = new Map(tree.entries.filter(entry => entry.type === "file").map(entry => [entry.path, entry]));
    const entries: UserspaceRootfsEntry[] = tree.entries.map(entry => {
      const nativeMode = modes.get(`/workspace/${entry.path}`);
      if (nativeMode === undefined) throw new VMError("PROTOCOL_ERROR", "ext4 metadata omitted a workspace entry");
      const common = { path: `workspace/${entry.path}`, mode: nativeMode & 0o777 };
      switch (entry.type) {
        case "directory": return { ...common, type: "directory" };
        case "symlink": return { ...common, type: "symlink", target: entry.target };
        case "file": return { ...common, type: "file", blob: entry.blob };
        case "hardlink": {
          const target = files.get(entry.target);
          if (target === undefined) throw new VMError("PROTOCOL_ERROR", "extracted workspace hardlink has no preceding regular inode");
          return { ...common, type: "file", blob: target.blob };
        }
      }
    });
    return (await userspaceTreeIdentity(entries, tree.blobs, 3)).workspaceBaseSha256;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** rdump stages bytes with private host permissions; stat retains the guest inode mode. */
async function diskModes(disk: string, paths: readonly string[], staging: string, signal?: AbortSignal): Promise<ReadonlyMap<string, number>> {
  return new Map([...(await diskFileMetadata(disk, paths, staging, signal))].map(([path, metadata]) => [path, metadata.mode]));
}

export async function diskFileMetadata(disk: string, paths: readonly string[], staging: string, signal?: AbortSignal): Promise<ReadonlyMap<string, SourceFileMetadata>> {
  const modes = new Map<string, SourceFileMetadata>(); const commands = join(staging, "metadata.commands");
  for (let offset = 0; offset < paths.length; offset += 256) {
    const batch = paths.slice(offset, offset + 256);
    await writeFile(commands, batch.map(path => `stat ${debugfsArgument(path)}\n`).join(""));
    const output = await runTool("debugfs", ["-f", commands, disk], signal === undefined ? {} : { signal });
    const records = output.split(/^debugfs: stat .+$/mu).slice(1);
    if (records.length !== batch.length) throw new VMError("PROTOCOL_ERROR", "unexpected e2fsprogs metadata framing");
    for (let index = 0; index < batch.length; index++) {
      const path = batch[index]; const record = records[index];
      const match = record?.match(/^Inode: \d+\s+Type: (?:regular|directory|symlink)\s+Mode:\s+(0?[0-7]{3,4})\s+Flags:/mu);
      const mode = match?.[1];
      const owner = record?.match(/^User:\s+(\d+)\s+Group:\s+(\d+)/mu);
      const uid = owner?.[1]; const gid = owner?.[2];
      if (path === undefined || mode === undefined || uid === undefined || gid === undefined) throw new VMError("INVALID_ARGUMENT", "ext4 workspace has missing or unsupported inode metadata");
      modes.set(path, { mode: Number.parseInt(mode, 8), ownership: { uid: Number(uid), gid: Number(gid) } });
    }
  }
  return modes;
}

/** Preserve final guest permissions/UIDs/GIDs after unprivileged host extraction. */
export async function writeDiskMetadata(disk: string, entries: readonly UserspaceRootfsEntry[], staging: string, signal?: AbortSignal, epoch?: number): Promise<void> {
  const commands = join(staging, "apply-metadata.commands");
  const timestamps = (path: string) => epoch === undefined ? "" : ["atime", "ctime", "mtime", "crtime"].map(field =>
    `set_inode_field ${path} ${field} @${String(epoch)}\nset_inode_field ${path} ${field}_extra 0\n`).join("");
  const env = epoch === undefined ? undefined : { ...process.env, E2FSPROGS_FAKE_TIME: String(epoch) };
  for (let offset = 0; offset < entries.length; offset += 256) {
    const batch = entries.slice(offset, offset + 256);
    await writeFile(commands, batch.map(entry => {
      const path = debugfsArgument(`/${entry.path}`);
      const type = entry.type === "directory" ? 0o40000 : entry.type === "symlink" ? 0o120000 : 0o100000;
      const owner = entry.ownership ?? { uid: 0, gid: 0 };
      return `set_inode_field ${path} mode 0${(type | entry.mode).toString(8)}\nset_inode_field ${path} uid ${String(owner.uid)}\nset_inode_field ${path} gid ${String(owner.gid)}\n${timestamps(path)}`;
    }).join(""));
    await runTool("debugfs", ["-w", "-f", commands, disk], { ...(signal === undefined ? {} : { signal }), ...(env === undefined ? {} : { env }) });
  }
  if (epoch !== undefined) {
    await writeFile(commands, timestamps(debugfsArgument("/")) + timestamps(debugfsArgument("/lost+found")));
    await runTool("debugfs", ["-w", "-f", commands, disk], { ...(env === undefined ? {} : { env }), ...(signal === undefined ? {} : { signal }) });
  }
}
