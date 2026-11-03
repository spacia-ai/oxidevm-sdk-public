import { VMError } from "../../runtime/errors.js";
import type { RunnerCopies, RunnerVerifiedFile } from "../../runtime/js-process/launch.js";
import type { HostArtifacts } from "../define.js";
import type { LaunchDescriptor } from "./descriptor.js";
import { ModuleFailure } from "./failure.js";

export interface VerifiedArtifacts extends HostArtifacts {
  /** The adapter bundle, verified against its pin, as JavaScript the runner imports. */
  adapter(): Promise<Blob>;
  /** Releases what `url` minted; the runner calls it when the module ends. */
  close(): void;
}

function unknownArtifact(name: string): VMError {
  return new VMError("INVALID_ARGUMENT", `${name} is not an artifact of this module`);
}

/** Reads a Blob without awaiting; the runner's own is the worker's `FileReaderSync`. */
export type SyncBlobReader = (blob: Blob) => Uint8Array<ArrayBuffer>;

/** `FileReaderSync`, which only workers have, behind a typed reader; a scope without it refuses the read. */
export const workerBlobReader: SyncBlobReader = blob => {
  const Reader: unknown = Reflect.get(globalThis, "FileReaderSync");
  if (typeof Reader !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", "Reading an artifact synchronously needs a worker's FileReaderSync", { reason: "wasm-artifact-sync-read" });
  const reader: unknown = Reflect.construct(Reader, []), read: unknown = typeof reader === "object" && reader !== null ? Reflect.get(reader, "readAsArrayBuffer") : undefined;
  const buffer: unknown = typeof read === "function" ? Reflect.apply(read, reader, [blob]) : undefined;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== blob.size) throw new VMError("FEATURE_NOT_AVAILABLE", "FileReaderSync did not read the artifact's copy", { reason: "wasm-artifact-sync-read" });
  return new Uint8Array(buffer);
};

/**
 * The adapter's view of its files (engine ADR 0028): the copies the VM's verified-copy store checked before the process
 * existed, for an application's start and for a program that ran one of the module's commands alike. Nothing is fetched
 * or hashed: `compile` returns the module compiled once for the VM (or compiles the verified bytes of a file that did not
 * compile then), `bytes` reads the copy, `blob` is the copy, `bytesSync` reads it without awaiting (`readSync`), and `url`
 * is a blob: URL of the copy, minted on first use and revoked when the module ends. Copies that are not exactly the
 * description's files are a launch failure.
 */
export function preverifiedArtifacts(descriptor: LaunchDescriptor, copies: RunnerCopies, readSync: SyncBlobReader = workerBlobReader): VerifiedArtifacts {
  const names = Object.keys(descriptor.artifacts);
  const matches = copies.adapter.size === descriptor.adapter.bytes && Object.keys(copies.artifacts).length === names.length
    && names.every(name => Object.hasOwn(copies.artifacts, name) && copies.artifacts[name]?.blob.size === descriptor.artifacts[name]?.bytes);
  if (!matches) throw new ModuleFailure("launch", "The verified copies of the module's files do not match its launch description");
  const urls = new Map<string, string>();
  function copyOf(name: string): RunnerVerifiedFile {
    const copy = Object.hasOwn(copies.artifacts, name) ? copies.artifacts[name] : undefined;
    if (copy === undefined) throw unknownArtifact(name);
    return copy;
  }
  return {
    adapter: () => Promise.resolve(copies.adapter),
    compile: async name => { const copy = copyOf(name); return copy.module ?? WebAssembly.compile(await copy.blob.arrayBuffer()); },
    bytes: async name => new Uint8Array(await copyOf(name).blob.arrayBuffer()),
    blob: name => copyOf(name).blob,
    // A fresh array each time, so a caller that changes it cannot change what the next read returns.
    bytesSync: name => readSync(copyOf(name).blob).slice(),
    url: name => {
      const copy = copyOf(name), existing = urls.get(name);
      if (existing !== undefined) return existing;
      const url = URL.createObjectURL(copy.blob);
      urls.set(name, url);
      return url;
    },
    close: () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); },
  };
}
