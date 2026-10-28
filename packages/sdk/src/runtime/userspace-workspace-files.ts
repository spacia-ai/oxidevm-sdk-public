import { VMError } from "./errors.js";
import type { UserspaceProcessBackend } from "./userspace-process.js";
import { decodeUserspaceFileRecord, decodeUserspaceFileChanges, encodeUserspaceFileRequest, isFileOperation, type UserspaceFileRequest, type UserspaceFileResult } from "./userspace-files.js";
import type { PreparedUserspaceRootfs } from "./protocol/storage.js";
import { MAX_WORKSPACE_FILE_BYTES, filesUnavailable, type WorkspaceFileBackend, type WorkspaceChange } from "./workspace-files.js";
import { WorkspaceWatches } from "./workspace-watches.js";
import { retryWorkspaceBusy } from "./workspace-retry.js";
import { pollDelay } from "./listening-ports.js";

/** All thirteen workspace methods meet at this native service. Storage persists its snapshots. */
export class UserspaceWorkspaceFiles implements WorkspaceFileBackend {
  readonly #watches: WorkspaceWatches;
  #mounting: Promise<void> | undefined;
  #mountedRoot: string | undefined;
  #generation = 0;
  constructor(readonly backend: Pick<UserspaceProcessBackend, "files" | "fileChanges">, readonly rootfs: () => PreparedUserspaceRootfs | undefined, readonly lifetime: AbortSignal) {
    this.#watches = new WorkspaceWatches({ open: async (onChange, onFailure) => {
      await this.#mount();
      const stopped = new AbortController(); const signal = AbortSignal.any([stopped.signal, lifetime]);
      const ended = () => signal.aborted;
      let cursor = decodeUserspaceFileChanges(await backend.fileChanges(0n, signal)).cursor;
      let generation = this.#generation;
      let resolved: readonly { readonly alias: string; readonly path: string }[] = [];
      void (async () => {
        while (!ended()) {
          await pollDelay(500, signal); if (ended()) return;
          if (generation !== this.#generation) { generation = this.#generation; cursor = 0n; }
          const result = decodeUserspaceFileChanges(await retryWorkspaceBusy(() => backend.fileChanges(cursor, signal), signal));
          if (ended()) return;
          if (generation !== this.#generation) continue;
          cursor = result.cursor;
          const changes: WorkspaceChange[] = [];
          for (const change of result.changes) {
            if (change.kind === "rescan") { changes.push(change); continue; }
            for (const directory of resolved) if (directory.path === change.directory) changes.push({ ...change, directory: directory.alias });
            if (changes.length > 1024) { changes.splice(0, changes.length, { kind: "rescan" }); break; }
          }
          // Moving/removing a watched directory invalidates its old path, even if its parent is not watched.
          if (result.changes.some(change => change.kind === "changed" && resolved.some(({ path }) => {
            const changed = `${change.directory === "/" ? "" : change.directory}/${change.name}`;
            return path === changed || path.startsWith(`${changed}/`);
          }))) changes.push({ kind: "rescan" });
          if (changes.length > 0) onChange(changes);
        }
      })().catch((error: unknown) => { if (!ended()) { stopped.abort(); onFailure(error); } });
      return {
        setDirectories: async paths => {
          const next = await Promise.all(paths.map(async path => {
            const entry = await this.stat(path, signal);
            if (entry.kind !== "directory" && entry.link?.kind !== "directory") throw new VMError("STORAGE_ERROR", "Watch path is not a directory", { reason: "not-a-directory" });

            // A directory entry may have an intermediate link rather than be a link itself.
            const parts = path.split("/").filter(Boolean); let prefix = "";
            for (const part of parts) { prefix = `${prefix}/${part}`; const node = prefix === path ? entry : await this.stat(prefix, signal); if (node.link?.path !== null && node.link?.path !== undefined) prefix = node.link.path === "/" ? "" : node.link.path; }
            const canonical = prefix === "" ? "/" : prefix;
            return { alias: path, path: canonical };
          }));
          resolved = next; onChange([{ kind: "rescan" }]);
        },
        close: () => { stopped.abort(); return Promise.resolve(); },
      };
    } }, lifetime);
  }

  restored(): void {
    this.#generation += 1;
    this.#mountedRoot = this.rootfs()?.rootTreeSha256;
    this.#watches.invalidate();
  }
  async entries(path = "/", signal?: AbortSignal) { return (await this.#request({ operation: "entries", path }, signal, "entries")).entries; }
  async stat(path: string, signal?: AbortSignal) { return (await this.#request({ operation: "stat", path }, signal, "stat")).entry; }
  async read(path: string, options: { maxBytes?: number; signal?: AbortSignal } = {}) {
    const { entry, data } = await this.#request({ operation: "read", path, maxBytes: options.maxBytes ?? MAX_WORKSPACE_FILE_BYTES }, options.signal, "read"); return { entry, data };
  }
  async write(path: string, data: Uint8Array, options: { ifVersion?: string | null; signal?: AbortSignal } = {}) {
    return (await this.#request({ operation: "write", path, data, ...(options.ifVersion === undefined ? {} : { ifVersion: options.ifVersion }) }, options.signal, "write")).entry;
  }
  async createDirectory(path: string, options: { signal?: AbortSignal } = {}) { await this.#request({ operation: "mkdir", path }, options.signal, "mkdir"); }
  async rename(from: string, to: string, options: { signal?: AbortSignal } = {}) { await this.#request({ operation: "rename", from, to }, options.signal, "rename"); }
  async readFile(path: string, signal?: AbortSignal) { return (await this.#request({ operation: "legacy-read", path }, signal, "legacy-read")).data; }
  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal) { await this.write(path, data, signal === undefined ? {} : { signal }); }
  async list(path: string, signal?: AbortSignal) { return (await this.entries(path, signal)).map(entry => ({ name: entry.name, path: entry.path, kind: entry.kind === "directory" || entry.link?.kind === "directory" ? "directory" as const : "file" as const, size: entry.size })); }
  async remove(path: string, recursive: boolean, signal?: AbortSignal) { await this.#request({ operation: "remove", path, recursive }, signal, "remove"); }
  watch: WorkspaceFileBackend["watch"] = (onChange, options) => this.#watches.watch(onChange, options);

  async #mount(): Promise<void> {
    if (this.lifetime.aborted) throw new VMError("ABORTED", "Userspace VM has stopped");
    const rootfs = this.rootfs(); if (rootfs === undefined) throw filesUnavailable("no-root-filesystem");
    if (this.#mountedRoot !== undefined && this.#mountedRoot !== rootfs.rootTreeSha256) throw new VMError("INVALID_ARGUMENT", "replace the VM before changing its mounted rootfs");
    if (this.#mounting !== undefined) return this.#mounting;
    const request = { operation: "stat", path: "/" } as const;
    const mounting = retryWorkspaceBusy(async () => {
      const bytes = await this.backend.files(encodeUserspaceFileRequest(request), {
        rootTreeSha256: rootfs.rootTreeSha256,
        workspaceBaseSha256: rootfs.workspaceBaseSha256 ?? rootfs.rootTreeSha256,
        cpuProfile: rootfs.cpuProfile, rootfs: rootfs.metadata,
      }, this.lifetime);
      decodeUserspaceFileRecord(bytes, request); this.#mountedRoot = rootfs.rootTreeSha256;
    }, this.lifetime);
    this.#mounting = mounting;
    try { await mounting; } catch (error) { if (this.#mounting === mounting) this.#mounting = undefined; throw error; }
  }
  async #request<K extends UserspaceFileResult["operation"]>(request: UserspaceFileRequest, signal: AbortSignal | undefined, operation: K): Promise<Extract<UserspaceFileResult, { operation: K }>> {
    await this.#mount();
    const result = await retryWorkspaceBusy(async () => decodeUserspaceFileRecord(await this.backend.files(encodeUserspaceFileRequest(request), undefined, signal), request), signal);
    if (!isFileOperation(result, operation)) throw new VMError("PROTOCOL_ERROR", "workspace response operation mismatch");
    return result;
  }
}
