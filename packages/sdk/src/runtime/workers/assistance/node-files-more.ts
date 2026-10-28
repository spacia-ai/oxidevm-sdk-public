import { VMError } from "../../errors.ts";
import { Dirent } from "./node-file-operations.js";

interface FilePromises {
  readdir(path: unknown, options?: unknown): Promise<unknown>;
  readFile(path: unknown): Promise<unknown>;
  writeFile(path: unknown, data: unknown): Promise<unknown>;
  mkdir(path: unknown, options?: unknown): Promise<unknown>;
  stat(path: unknown): Promise<unknown>;
  lstat(path: unknown): Promise<unknown>;
}

function isDirectory(entry: unknown): boolean {
  const probe: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "isDirectory") : undefined;
  return typeof probe === "function" && Reflect.apply(probe, entry, []) === true;
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError("file content must be bytes");
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** `fs.cp`, `fs/promises.mkdtemp` and `fs.opendir` over the
 * runtime's real file operations. `cp` walks directories through readdir and
 * copies file bytes; `mkdtemp` retries a six-character suffix until the
 * directory is new. */
export function createNodeFilesMore(promises: FilePromises) {
  async function opendir(path: unknown, options?: unknown) {
    const input = typeof options === "string" ? { encoding: options } : options;
    if (input !== undefined && (typeof input !== "object" || input === null)) throw new TypeError("Invalid opendir options");
    const encoding: unknown = input === undefined ? undefined : Reflect.get(input, "encoding");
    if (input !== undefined && (Reflect.get(input, "recursive") === true || (encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8"))) throw new VMError("FEATURE_NOT_AVAILABLE", "Recursive or non-UTF-8 directory iteration is not qualified");
    const listed = await promises.readdir(path, { withFileTypes: true });
    if (!Array.isArray(listed)) throw new TypeError("Invalid directory listing");
    const entries = listed.map((entry: unknown) => { if (!(entry instanceof Dirent)) throw new TypeError("Invalid directory entry"); return entry; });
    let offset = 0, closed = false;
    const check = () => { if (closed) throw Object.assign(new Error("Directory handle was closed"), { code: "ERR_DIR_CLOSED" }); };
    // shortcut: opendir buffers the bounded Rust listing; stream getdents for larger directory profiles.
    return { path,
      read(): Promise<Dirent | null> { return Promise.resolve().then(() => { check(); return entries[offset++] ?? null; }); },
      close(): Promise<void> { return Promise.resolve().then(() => { check(); closed = true; }); },
      async *[Symbol.asyncIterator](): AsyncGenerator<Dirent> {
        try { for (;;) { const entry = await this.read(); if (entry === null) return; yield entry; } }
        finally { closed = true; }
      },
    };
  }
  async function cp(source: unknown, destination: unknown, options?: unknown): Promise<void> {
    const from = String(source); const to = String(destination);
    const recursive = typeof options === "object" && options !== null && Reflect.get(options, "recursive") === true;
    const status = await promises.stat(from);
    if (isDirectory(status)) {
      if (!recursive) throw Object.assign(new Error(`Recursive option is required to copy a directory: ${from}`), { code: "ERR_FS_EISDIR" });
      await promises.mkdir(to, { recursive: true });
      const entries = await promises.readdir(from, { withFileTypes: true });
      for (const entry of Array.isArray(entries) ? entries : []) {
        const name: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "name") : entry;
        if (typeof name !== "string") continue;
        await cp(`${from}/${name}`, `${to}/${name}`, options);
      }
      return;
    }
    await promises.writeFile(to, bytesOf(await promises.readFile(from)));
  }
  async function mkdtemp(prefix: unknown): Promise<string> {
    if (typeof prefix !== "string") throw Object.assign(new TypeError("The \"prefix\" argument must be of type string"), { code: "ERR_INVALID_ARG_TYPE" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const random = new Uint8Array(6);
      globalThis.crypto.getRandomValues(random);
      const path = prefix + [...random].map(byte => ALPHABET[byte % ALPHABET.length]).join("");
      try { await promises.mkdir(path); return path; }
      catch (error) { if (!(typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST")) throw error; }
    }
    throw Object.assign(new Error("mkdtemp: too many attempts"), { code: "EEXIST" });
  }
  return { promises: { cp, mkdtemp, opendir }, cp: (source: unknown, destination: unknown, options: unknown, callback?: unknown): void => {
    if (typeof options === "function") { callback = options; options = undefined; }
    cp(source, destination, options).then(() => { if (typeof callback === "function") Reflect.apply(callback, undefined, [null]); },
      (error: unknown) => { if (typeof callback === "function") Reflect.apply(callback, undefined, [error]); });
  } };
}
