/**
 * An origin's storage limit for a tree of memory directories: growing a file past it throws the
 * QuotaExceededError browsers throw, and removing files gives the space back. A file with an open
 * sync access handle keeps the most it has held until the handle closes, as Chromium keeps a
 * handle's capacity; only then does shrinking it give space back.
 */
export class MemoryQuota {
  limit: number;
  #used = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Bytes the files below the tree hold. */
  get used(): number {
    return this.#used;
  }

  /** Accounts for files growing or shrinking by `delta` bytes; refuses growth past the limit. */
  change(delta: number): void {
    if (delta > 0 && this.#used + delta > this.limit) {
      throw new DOMException("the origin has no storage left", "QuotaExceededError");
    }
    this.#used += delta;
  }
}

/**
 * In-memory OPFS for storage tests: directories, atomic writable streams and exclusive sync
 * access handles, failing with the DOMException names the browser uses.
 */
export class MemoryDirectory implements FileSystemDirectoryHandle {
  readonly kind = "directory";
  readonly name: string;
  readonly #entries = new Map<string, MemoryDirectory | MemoryFile>();
  readonly #journal: string[] | undefined;
  readonly #quota: MemoryQuota | undefined;
  #writeFailure: DOMException | undefined;

  /**
   * A shared `journal` receives `<file>:write` and `<file>:flush` for every sync handle below; a
   * `quota` limits what the files below may hold together.
   */
  constructor(name = "", journal?: string[], quota?: MemoryQuota) {
    this.name = name;
    this.#journal = journal;
    this.#quota = quota;
  }

  async getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FileSystemDirectoryHandle> {
    await Promise.resolve();
    return this.directory(name, options?.create === true);
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    await Promise.resolve();
    return this.file(name, options?.create === true);
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    await Promise.resolve();
    const entry = this.#entries.get(validName(name));
    if (entry === undefined) throw new DOMException(`${name} was not found`, "NotFoundError");
    if (entry instanceof MemoryDirectory && entry.#entries.size !== 0 && options?.recursive !== true) {
      throw new DOMException(`${name} is not empty`, "InvalidModificationError");
    }
    if (entry.locked) throw new DOMException(`${name} has an open access handle`, "NoModificationAllowedError");
    this.#entries.delete(name);
    this.#quota?.change(-entry.charged);
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    await Promise.resolve();
    for (const [name, entry] of this.#entries) {
      if (entry === possibleDescendant) return [name];
      if (entry instanceof MemoryDirectory) {
        const path = await entry.resolve(possibleDescendant);
        if (path !== null) return [name, ...path];
      }
    }
    return null;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    await Promise.resolve();
    return other === this;
  }

  async *entries(): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
    for (const entry of [...this.#entries]) {
      await Promise.resolve();
      yield entry;
    }
  }

  async *keys(): FileSystemDirectoryHandleAsyncIterator<string> {
    for await (const [name] of this.entries()) yield name;
  }

  async *values(): FileSystemDirectoryHandleAsyncIterator<FileSystemDirectoryHandle | FileSystemFileHandle> {
    for await (const [, entry] of this.entries()) yield entry;
  }

  [Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
    return this.entries();
  }

  /** Whether any file below this directory has an open sync access handle. */
  get locked(): boolean {
    return [...this.#entries.values()].some((entry) => entry.locked);
  }

  /** Bytes the files below this directory count against the quota. */
  get charged(): number {
    return [...this.#entries.values()].reduce((total, entry) => total + entry.charged, 0);
  }

  /** Makes every sync access handle write to a file of this directory throw `error` (undefined: write again). */
  failWrites(error: DOMException | undefined): void {
    this.#writeFailure = error;
  }

  /** The names in this directory, sorted. */
  names(): string[] {
    return [...this.#entries.keys()].sort();
  }

  /** The subdirectory or file at a slash-separated path, if it exists. */
  find(path: string): MemoryDirectory | MemoryFile | undefined {
    const [name, ...rest] = path.split("/").filter((part) => part !== "");
    if (name === undefined) return this;
    const entry = this.#entries.get(name);
    if (rest.length === 0) return entry;
    return entry instanceof MemoryDirectory ? entry.find(rest.join("/")) : undefined;
  }

  directory(name: string, create: boolean): MemoryDirectory {
    const entry = this.#entries.get(validName(name));
    if (entry instanceof MemoryDirectory) return entry;
    if (entry !== undefined) throw new DOMException(`${name} is a file`, "TypeMismatchError");
    if (!create) throw new DOMException(`${name} was not found`, "NotFoundError");
    const created = new MemoryDirectory(name, this.#journal, this.#quota);
    this.#entries.set(name, created);
    return created;
  }

  file(name: string, create: boolean): MemoryFile {
    const entry = this.#entries.get(validName(name));
    if (entry instanceof MemoryFile) return entry;
    if (entry !== undefined) throw new DOMException(`${name} is a directory`, "TypeMismatchError");
    if (!create) throw new DOMException(`${name} was not found`, "NotFoundError");
    const created = new MemoryFile(name, this.#journal, () => this.#writeFailure, this.#quota);
    this.#entries.set(name, created);
    return created;
  }
}

export class MemoryFile implements FileSystemFileHandle {
  readonly kind = "file";
  readonly name: string;
  #contents: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  #charged = 0;
  #syncHandleOpen = false;
  #commits = 0;
  #syncWrites = 0;
  readonly #journal: string[] | undefined;
  readonly #writeFailure: () => DOMException | undefined;
  readonly #quota: MemoryQuota | undefined;

  constructor(
    name: string,
    journal?: string[],
    writeFailure: () => DOMException | undefined = () => undefined,
    quota?: MemoryQuota,
  ) {
    this.name = name;
    this.#journal = journal;
    this.#writeFailure = writeFailure;
    this.#quota = quota;
  }

  /** How many sync access handle writes reached this file. */
  get syncWrites(): number {
    return this.#syncWrites;
  }

  /** How many writable streams committed to this file. */
  get commits(): number {
    return this.#commits;
  }

  /** A copy of the committed contents. */
  get bytes(): Uint8Array<ArrayBuffer> {
    return this.#contents.slice();
  }

  get locked(): boolean {
    return this.#syncHandleOpen;
  }

  get size(): number {
    return this.#contents.byteLength;
  }

  /** Bytes this file counts against the quota. */
  get charged(): number {
    return this.#charged;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    await Promise.resolve();
    return other === this;
  }

  async getFile(): Promise<File> {
    await Promise.resolve();
    return new File([this.#contents.slice()], this.name);
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    await Promise.resolve();
    if (this.#syncHandleOpen) throw new DOMException(`${this.name} is locked`, "NoModificationAllowedError");
    return new MemoryWritable(
      (contents) => {
        this.#replace(contents, false);
        this.#commits += 1;
      },
      options?.keepExistingData === true ? this.#contents.slice() : new Uint8Array(0),
    );
  }

  async createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
    await Promise.resolve();
    if (this.#syncHandleOpen) throw new DOMException(`${this.name} is locked`, "NoModificationAllowedError");
    this.#syncHandleOpen = true;
    return new MemorySyncHandle({
      failure: () => this.#writeFailure(),
      contents: () => this.#contents,
      replace: (contents) => {
        this.#replace(contents, true);
      },
      record: (operation) => {
        if (operation === "write") this.#syncWrites += 1;
        this.#journal?.push(`${this.name}:${operation}`);
      },
      release: () => {
        this.#syncHandleOpen = false;
        // The closed handle gives back what the file no longer holds.
        this.#quota?.change(this.#contents.byteLength - this.#charged);
        this.#charged = this.#contents.byteLength;
      },
    });
  }

  /** Replaces the committed contents, as a crash-free write would. */
  setBytes(bytes: Uint8Array): void {
    this.#replace(new Uint8Array(bytes), false);
  }

  /**
   * Swaps in new contents once the quota, if any, accepts them; `holding` (an open sync access
   * handle) keeps the most the file has held counted.
   */
  #replace(contents: Uint8Array<ArrayBuffer>, holding: boolean): void {
    const charged = holding ? Math.max(this.#charged, contents.byteLength) : contents.byteLength;
    this.#quota?.change(charged - this.#charged);
    this.#charged = charged;
    this.#contents = contents;
  }
}

interface SyncTarget {
  /** The error a write throws instead of writing, if any. */
  failure(): DOMException | undefined;
  contents(): Uint8Array<ArrayBuffer>;
  replace(contents: Uint8Array<ArrayBuffer>): void;
  record(operation: "write" | "flush"): void;
  release(): void;
}

class MemorySyncHandle implements FileSystemSyncAccessHandle {
  readonly #target: SyncTarget;
  #cursor = 0;
  #closed = false;

  constructor(target: SyncTarget) {
    this.#target = target;
  }

  read(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number {
    this.#assertOpen();
    const destination = viewOf(buffer);
    const at = options?.at ?? this.#cursor;
    const contents = this.#target.contents();
    const count = Math.max(0, Math.min(destination.byteLength, contents.byteLength - at));
    destination.set(contents.subarray(at, at + count));
    this.#cursor = at + count;
    return count;
  }

  write(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number {
    this.#assertOpen();
    const failure = this.#target.failure();
    if (failure !== undefined) throw failure;
    const source = viewOf(buffer);
    const at = options?.at ?? this.#cursor;
    const end = at + source.byteLength;
    let contents = this.#target.contents();
    if (end > contents.byteLength) {
      contents = resized(contents, end);
      this.#target.replace(contents);
    }
    // Sync access handle writes land in place, as they do in the browser.
    contents.set(source, at);
    this.#cursor = end;
    this.#target.record("write");
    return source.byteLength;
  }

  truncate(newSize: number): void {
    this.#assertOpen();
    this.#target.replace(resized(this.#target.contents(), newSize));
  }

  getSize(): number {
    this.#assertOpen();
    return this.#target.contents().byteLength;
  }

  flush(): void {
    this.#assertOpen();
    this.#target.record("flush");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#target.release();
  }

  #assertOpen(): void {
    if (this.#closed) throw new DOMException("the access handle is closed", "InvalidStateError");
  }
}

class MemoryWritable extends WritableStream implements FileSystemWritableFileStream {
  readonly #commit: (contents: Uint8Array<ArrayBuffer>) => void;
  #contents: Uint8Array<ArrayBuffer>;
  #position = 0;
  #finished = false;

  constructor(commit: (contents: Uint8Array<ArrayBuffer>) => void, initial: Uint8Array<ArrayBuffer>) {
    super();
    this.#commit = commit;
    this.#contents = initial;
  }

  async write(data: FileSystemWriteChunkType): Promise<void> {
    this.#assertWritable();
    if (isWriteParams(data)) {
      if (data.type === "seek") {
        this.#position = data.position ?? 0;
      } else if (data.type === "truncate") {
        this.#contents = resized(this.#contents, data.size ?? 0);
      } else {
        if (data.position !== undefined && data.position !== null) this.#position = data.position;
        if (data.data !== undefined && data.data !== null) await this.#put(data.data);
      }
      return;
    }
    await this.#put(data);
  }

  async seek(position: number): Promise<void> {
    await Promise.resolve();
    this.#assertWritable();
    this.#position = position;
  }

  async truncate(size: number): Promise<void> {
    await Promise.resolve();
    this.#assertWritable();
    this.#contents = resized(this.#contents, size);
    this.#position = Math.min(this.#position, size);
  }

  override async close(): Promise<void> {
    await Promise.resolve();
    this.#assertWritable();
    this.#finished = true;
    this.#commit(this.#contents);
  }

  override async abort(): Promise<void> {
    await Promise.resolve();
    this.#finished = true;
  }

  async #put(data: BufferSource | Blob | string): Promise<void> {
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : viewOf(data);
    const contents = resized(this.#contents, Math.max(this.#contents.byteLength, this.#position + bytes.byteLength));
    contents.set(bytes, this.#position);
    this.#contents = contents;
    this.#position += bytes.byteLength;
  }

  #assertWritable(): void {
    if (this.#finished) throw new TypeError("the writable stream is closed");
  }
}

function isWriteParams(data: FileSystemWriteChunkType): data is WriteParams {
  return typeof data === "object" && !(data instanceof Blob) && !(data instanceof ArrayBuffer)
    && !ArrayBuffer.isView(data);
}

function viewOf(buffer: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
}

function resized(contents: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("invalid file size");
  const next = new Uint8Array(size);
  next.set(contents.subarray(0, Math.min(size, contents.byteLength)));
  return next;
}

function validName(name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/")) {
    throw new TypeError(`invalid OPFS entry name ${JSON.stringify(name)}`);
  }
  return name;
}
