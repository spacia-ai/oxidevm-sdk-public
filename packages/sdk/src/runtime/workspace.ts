import type { WorkspaceEntry } from "./protocol.js";
import { TextDecoder, TextEncoder } from "./web-encoding.js";
import { normalizeWorkspacePath } from "./workspace-path.js";
import { VMError } from "./errors.js";
import { filesUnavailable, MAX_WORKSPACE_FILE_BYTES, validateWorkspaceReadLimit, validateWorkspaceVersion } from "./workspace-files.js";
import type {
  WorkspaceChange, WorkspaceFile, WorkspaceFileBackend, WorkspaceFileEntry, WorkspaceOperationOptions, WorkspaceReadOptions, WorkspaceWatch,
  WorkspaceWatchOptions, WorkspaceWriteOptions,
} from "./workspace-files.js";

export interface Workspace extends WorkspaceFileBackend {
  readonly id: string;
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  readText(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(
    path: string,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  writeText(path: string, data: string, signal?: AbortSignal): Promise<void>;
  list(path?: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>;
  remove(
    path: string,
    options?: { recursive?: boolean; signal?: AbortSignal },
  ): Promise<void>;
}

export interface WorkspaceBackend {
  readonly files?: WorkspaceFileBackend;
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
  ): Promise<void>;
  list(path: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>;
  remove(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class BrowserWorkspace implements Workspace {
  readonly id: string;
  readonly #backend: WorkspaceBackend;

  constructor(id: string, backend: WorkspaceBackend) {
    this.id = id;
    this.#backend = backend;
  }

  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    normalizeWorkspacePath(path);
    return this.#backend.readFile(path, signal);
  }

  async readText(path: string, signal?: AbortSignal): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path, signal));
  }

  writeFile(
    path: string,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    normalizeWorkspacePath(path);
    const copy = data.slice();
    return this.#backend.writeFile(path, copy, signal);
  }

  writeText(path: string, data: string, signal?: AbortSignal): Promise<void> {
    return this.writeFile(path, new TextEncoder().encode(data), signal);
  }

  list(path = "/", signal?: AbortSignal): Promise<WorkspaceEntry[]> {
    normalizeWorkspacePath(path);
    return this.#backend.list(path, signal);
  }

  remove(
    path: string,
    options: { recursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    normalizeWorkspacePath(path);
    return this.#backend.remove(
      path,
      options.recursive ?? false,
      options.signal,
    );
  }

  async entries(path = "/", signal?: AbortSignal): Promise<WorkspaceFileEntry[]> {
    normalizeWorkspacePath(path);
    return this.#files().entries(path, signal);
  }

  async stat(path: string, signal?: AbortSignal): Promise<WorkspaceFileEntry> {
    normalizeWorkspacePath(path);
    return this.#files().stat(path, signal);
  }

  async read(path: string, options: WorkspaceReadOptions = {}): Promise<WorkspaceFile> {
    normalizeWorkspacePath(path);
    validateWorkspaceReadLimit(options.maxBytes);
    return this.#files().read(path, options);
  }

  write(path: string, data: Uint8Array, options: WorkspaceWriteOptions = {}): Promise<WorkspaceFileEntry> {
    normalizeWorkspacePath(path);
    validateWorkspaceVersion(options.ifVersion);
    if (data.byteLength > MAX_WORKSPACE_FILE_BYTES) {
      throw new VMError("STORAGE_ERROR", "File exceeds 16 MiB", { reason: "too-large", size: data.byteLength });
    }
    const files = this.#backend.files;
    return files === undefined ? Promise.reject(filesUnavailable()) : files.write(path, data.slice(), options);
  }

  async createDirectory(path: string, options: WorkspaceOperationOptions = {}): Promise<void> {
    normalizeWorkspacePath(path);
    return this.#files().createDirectory(path, options);
  }

  async rename(from: string, to: string, options: WorkspaceOperationOptions = {}): Promise<void> {
    normalizeWorkspacePath(from);
    normalizeWorkspacePath(to);
    return this.#files().rename(from, to, options);
  }

  watch(onChange: (changes: readonly WorkspaceChange[]) => void, options: WorkspaceWatchOptions): WorkspaceWatch {
    return this.#files().watch(onChange, options);
  }

  #files(): WorkspaceFileBackend {
    const files = this.#backend.files;
    if (files === undefined) throw filesUnavailable();
    return files;
  }
}
