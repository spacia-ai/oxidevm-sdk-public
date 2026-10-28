import { VMError } from "../errors.js";
import { normalizeWorkspacePath } from "../workspace-path.js";
import { decodeWorkspaceOverlayManifest, digest, parseJson, streamReferences } from "./workspace-manifest.js";
import { readWorkspaceStream } from "./workspace-stream.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";

/** The storage backend already belongs to one workspace. System files use the
 * existing stream publication owner, isolated by exact immutable root identity. */
export async function openUserspaceRootStore(backend: WorkspaceStoreBackend, rootTreeSha256: string): Promise<WorkspaceStore> {
  digest(rootTreeSha256, "Userspace rootfs SHA-256");
  const prefix = `userspace-roots/${rootTreeSha256}/`;
  const scoped: WorkspaceStoreBackend = {
    ...(backend.mutate === undefined ? {} : { mutate: backend.mutate.bind(backend) }),
    async *list(start) {
      for await (const path of backend.list(prefix + start)) {
        if (!path.startsWith(prefix + start)) throw new VMError("STORAGE_ERROR", "Root overlay enumeration escaped its namespace");
        yield path.slice(prefix.length);
      }
    },
    read: (path, maximum, signal) => backend.read(prefix + relative(path), maximum, signal),
    write: (path, bytes) => backend.write(prefix + relative(path), bytes),
    remove: path => backend.remove(prefix + relative(path)),
  };
  if (scoped.mutate === undefined) await recoverRootPublication(scoped, rootTreeSha256);
  else await scoped.mutate(() => recoverRootPublication(scoped, rootTreeSha256));
  return new WorkspaceStore(scoped);
}

async function recoverRootPublication(backend: WorkspaceStoreBackend, identity: string): Promise<void> {
  const activeBytes = await backend.read("active.json", 128 * 1024);
  const intentBytes = await backend.read("intent.json", 128 * 1024);
  const active = activeBytes?.length === 0 ? undefined : activeBytes;
  const intent = intentBytes?.length === 0 ? undefined : intentBytes;
  const decode = (bytes: Uint8Array<ArrayBuffer>) => {
    const manifest = decodeWorkspaceOverlayManifest(parseJson(bytes));
    if (manifest.formatVersion !== 2 || manifest.workspaceBaseSha256 !== identity
      || manifest.dependencies !== undefined || manifest.delta.bytes !== 0) {
      throw new VMError("STORAGE_ERROR", "Userspace root overlay identity or format is invalid");
    }
    return manifest;
  };
  const selected = active === undefined ? undefined : decode(active);
  if (intent !== undefined) decode(intent);
  // OPFS creates an empty file before its first atomic writable close.
  if (activeBytes?.length === 0) await backend.remove("active.json");
  if (intentBytes?.length === 0) await backend.remove("intent.json");
  if (intent === undefined) return;
  if (active !== undefined && active.length === intent.length && active.every((byte, i) => byte === intent[i])) return;
  // A lost writer never acknowledged this candidate. Verify the selected
  // generation before discarding the intent; normal staging recovery reclaims it.
  if (selected !== undefined) {
    for (const ref of streamReferences(selected)) {
      for await (const frame of readWorkspaceStream(backend, ref, new AbortController().signal)) void frame;
    }
  }
  await backend.remove("intent.json");
}

function relative(path: string): string {
  const parts = normalizeWorkspacePath(path);
  if (parts.length === 0 || parts.join("/") !== path) throw new VMError("STORAGE_ERROR", "Invalid root overlay object path");
  return path;
}
