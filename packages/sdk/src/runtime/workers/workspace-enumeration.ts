import { VMError } from "../errors.js";
import { normalizeWorkspacePath } from "../workspace-path.js";

/** Each transaction finishes before yielding; deletions cannot invalidate a
 * held cursor and recovery never materializes the complete key collection. */
export async function* indexedDbWorkspacePaths(database: IDBDatabase, prefix: string): AsyncGenerator<string> {
  let after: string | undefined;
  for (;;) {
    const range = IDBKeyRange.bound(after ?? prefix, `${prefix}\uffff`, after !== undefined, true);
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const transaction = database.transaction("files", "readonly");
      const request = transaction.objectStore("files").getAllKeys(range, 128);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new VMError("STORAGE_ERROR", "Workspace recovery enumeration failed"));
      transaction.onabort = () => reject(transaction.error ?? new VMError("STORAGE_ERROR", "Workspace recovery enumeration aborted"));
    });
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(prefix) || (after !== undefined && key <= after)) throw new VMError("STORAGE_ERROR", "Invalid workspace recovery key");
      after = key;
      yield key;
    }
    if (keys.length < 128) return;
  }
}

export async function* opfsWorkspacePaths(root: FileSystemDirectoryHandle, prefix: string): AsyncGenerator<string> {
  if(prefix==="") {
    yield* initialWorkspaceMetadata(root);
    return;
  }
  const segments = normalizeWorkspacePath(prefix);
  const selections = prefix === "selections/kept/" || prefix === "selections/manifests/";
  if (!prefix.endsWith("/") || !selections && !["staging", "preserved"].includes(segments.at(-1) ?? "")) throw new VMError("STORAGE_ERROR", "Unsupported workspace recovery prefix");
  let staging: FileSystemDirectoryHandle;
  try {
    staging = root;
    for (const segment of segments) staging = await staging.getDirectoryHandle(segment);
  }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  for await (const [name, handle] of staging.entries()) {
    if (selections) {
      if (handle.kind !== "file") throw new VMError("STORAGE_ERROR", `Invalid workspace ${prefix} entry`);
      yield `${prefix}${name}`;
      continue;
    }
    if (handle.kind !== "directory") throw new VMError("STORAGE_ERROR", `Invalid workspace ${prefix} directory`);
    const directory = await staging.getDirectoryHandle(name);
    for await (const [page, entry] of directory.entries()) {
      if (entry.kind !== "file") throw new VMError("STORAGE_ERROR", `Invalid workspace ${prefix} entry`);
      yield `${prefix}${name}/${page}`;
    }
  }
}

/** Initial-start inspection reads live metadata, never traverses immutable file objects. */
async function* initialWorkspaceMetadata(root:FileSystemDirectoryHandle):AsyncGenerator<string> {
  const live=async function* (directory:FileSystemDirectoryHandle,prefix:string):AsyncGenerator<string> {
    for(const name of ["active.json","intent.json"]) {
      try {await directory.getFileHandle(name);yield prefix+name;}
      catch(error){if(!(error instanceof DOMException)||error.name!=="NotFoundError")throw error;}
    }
  };
  yield* live(root,"");
  let roots:FileSystemDirectoryHandle;
  try {roots=await root.getDirectoryHandle("userspace-roots");}
  catch(error){if(error instanceof DOMException&&error.name==="NotFoundError")return;throw error;}
  let scanned=0;
  for await(const [name,handle] of roots.entries()) {
    if(++scanned>4096||handle.kind!=="directory"||!/^[a-f0-9]{64}$/u.test(name))throw new VMError("STORAGE_ERROR","Initial root metadata is invalid or exceeds its bound");
    yield* live(handle,`userspace-roots/${name}/`);
  }
}
