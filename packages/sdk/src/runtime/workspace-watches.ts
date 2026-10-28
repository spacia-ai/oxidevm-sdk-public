import { VMError, serializeUnknownError, deserializeError } from "./errors.js";
import { workspaceFilePath } from "./protocol/agent-files.js";
import { MAX_WORKSPACE_WATCH_DIRECTORIES, type WorkspaceChange, type WorkspaceWatch } from "./workspace-files.js";

/** Native inotify and the Userspace journal are the two transports of the same public watch. */
export interface WorkspaceWatchTransport {
  open(onChange: (changes: readonly WorkspaceChange[]) => void, onFailure: (error: unknown) => void): Promise<{
    setDirectories(paths: readonly string[]): Promise<void>;
    close(): Promise<void>;
  }>;
}
interface Watcher {
  readonly onChange: (changes: readonly WorkspaceChange[]) => void;
  readonly settle: (error?: unknown) => void;
  directories: readonly string[];
}

export class WorkspaceWatches {
  readonly #watchers = new Set<Watcher>();
  #subscription: Awaited<ReturnType<WorkspaceWatchTransport["open"]>> | undefined;
  #requests: Promise<unknown> = Promise.resolve();
  constructor(readonly transport: WorkspaceWatchTransport, readonly lifetime: AbortSignal) {
    lifetime.addEventListener("abort", () => this.#fail(new VMError("ABORTED", "the VM stopped watching workspace files")), { once: true });
  }

  invalidate(): void { this.#deliver([{ kind: "rescan" }]); }

  watch(onChange: (changes: readonly WorkspaceChange[]) => void, { signal }: { signal: AbortSignal }): WorkspaceWatch {
    let watcher: Watcher;
    const done = new Promise<void>((resolve, reject) => {
      watcher = { onChange, directories: [], settle: (error) => {
        if (!this.#watchers.delete(watcher)) return;
        signal.removeEventListener("abort", abort);
        if (error === undefined) resolve(); else reject(error instanceof Error ? error : deserializeError(serializeUnknownError(error)));
      } };
      const abort = () => { watcher.settle(); void this.#send(() => this.#replace()).catch((error: unknown) => this.#fail(error)); };
      this.#watchers.add(watcher);
      if (signal.aborted) abort();
      else if (this.lifetime.aborted) watcher.settle(new VMError("ABORTED", "the VM has stopped"));
      else signal.addEventListener("abort", abort, { once: true });
    });
    return { done, setDirectories: paths => {
      let directories: string[];
      try { directories = [...new Set(paths.map(workspaceFilePath))].sort(); } catch (error) { return Promise.reject(error instanceof Error ? error : deserializeError(serializeUnknownError(error))); }
      return this.#send(async () => {
        if (!this.#watchers.has(watcher)) throw new VMError("ABORTED", "workspace watch has ended");
        const previous = watcher.directories; watcher.directories = directories;
        try { await this.#replace(); } catch (error) { watcher.directories = previous; throw error; }
      });
    } };
  }

  #send(operation: () => Promise<void>): Promise<void> {
    const result = this.#requests.then(operation); this.#requests = result.catch(() => undefined); return result;
  }
  async #replace(): Promise<void> {
    const paths = [...new Set([...this.#watchers].flatMap(watcher => watcher.directories))].sort();
    if (paths.length > MAX_WORKSPACE_WATCH_DIRECTORIES) throw new VMError("INVALID_ARGUMENT", "at most 256 directories may be watched per VM");
    if (this.#watchers.size === 0) {
      const subscription = this.#subscription; this.#subscription = undefined; await subscription?.close(); return;
    }
    if (this.#subscription === undefined) {
      try { this.#subscription = await this.transport.open(changes => this.#deliver(changes), error => this.#fail(error)); }
      catch (error) { this.#fail(error); throw error; }
    }
    await this.#subscription.setDirectories(paths);
  }
  #deliver(changes: readonly WorkspaceChange[]): void {
    for (const watcher of this.#watchers) {
      const relevant = changes.filter(change => change.kind === "rescan" || watcher.directories.includes(change.directory));
      if (relevant.length > 0) queueMicrotask(() => { if (this.#watchers.has(watcher)) watcher.onChange(relevant); });
    }
  }
  #fail(error: unknown): void {
    for (const watcher of [...this.#watchers]) watcher.settle(error);
    void this.#send(() => this.#replace()).catch(() => undefined);
  }
}
