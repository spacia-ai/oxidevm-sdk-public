import { VMError } from "../../runtime/errors.js";
import type { RunnerCommandLaunch, RunnerVerifiedFile } from "../../runtime/js-process/launch.js";
import type { HostArtifacts } from "../define.js";
import type { PinnedFile } from "../handle.js";
import type { LaunchDescriptor } from "./descriptor.js";
import { ModuleFailure } from "./failure.js";
import { ADAPTER_FILE, loadPinned, type Fetcher } from "./pinned.js";

export interface VerifiedArtifacts extends HostArtifacts {
  /** The adapter bundle, verified against its pin, as JavaScript the runner imports. */
  adapter(): Promise<Blob>;
  /**
   * Checks every pinned artifact before the adapter's code runs, so a file that was altered after staging is refused even
   * if the adapter never loads it through `bytes`.
   */
  verifyAll(): Promise<void>;
  /** Releases what `url` minted; the runner calls it when the module ends. */
  close(): void;
}

/** The adapter's key in the cache of loaded files; no artifact name starts with NUL. */
const ADAPTER_KEY = "\0adapter";

function unknownArtifact(name: string): VMError {
  return new VMError("INVALID_ARGUMENT", `${name} is not an artifact of this module`);
}

/**
 * The adapter's view of its files when the application starts the module (`spawnModule`). Every pinned file has been
 * checked against the pins in `module.json` before the adapter's code runs (`verifyAll`), and `bytes` and `compile` check
 * again what they hand over. `url` only names the pinned location: a loader that fetches its own file from it is not
 * checked at that moment, only when the module started.
 */
export function createArtifacts(descriptor: LaunchDescriptor, fetcher: Fetcher, signal: AbortSignal): VerifiedArtifacts {
  const loaded = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  function pinFor(name: string): PinnedFile {
    const pin = Object.hasOwn(descriptor.artifacts, name) ? descriptor.artifacts[name] : undefined;
    if (pin === undefined) throw unknownArtifact(name);
    return pin;
  }
  function verified(key: string, pin: PinnedFile, label: string): Promise<Uint8Array<ArrayBuffer>> {
    const existing = loaded.get(key);
    if (existing !== undefined) return existing;
    const started = loadPinned(pin, label, key === ADAPTER_KEY ? ADAPTER_FILE : key, fetcher, signal);
    loaded.set(key, started);
    return started;
  }
  return {
    adapter: async () => new Blob([await verified(ADAPTER_KEY, descriptor.adapter, "The adapter bundle")], { type: "text/javascript" }),
    verifyAll: async () => {
      for (const [name, pin] of Object.entries(descriptor.artifacts)) await loadPinned(pin, `Artifact ${name}`, name, fetcher, signal);
    },
    compile: async name => WebAssembly.compile(await verified(name, pinFor(name), `Artifact ${name}`)),
    bytes: async name => (await verified(name, pinFor(name), `Artifact ${name}`)).slice(),
    url: name => pinFor(name).url,
    close: () => undefined,
  };
}

/**
 * The adapter's view of its files when a program in the VM runs one of its commands (engine ADR 0027): the copies the
 * Userspace worker verified when the commands were turned on. Nothing is fetched or hashed again: `compile` returns the
 * module compiled then (or compiles the verified bytes of a file that did not compile then), `bytes` reads the copy, and
 * `url` is a blob: URL of the copy, minted on first use and revoked when the module ends. Copies that are not exactly
 * the description's files are a launch failure.
 */
export function preverifiedArtifacts(descriptor: LaunchDescriptor, copies: Pick<RunnerCommandLaunch, "adapter" | "artifacts">): VerifiedArtifacts {
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
    verifyAll: () => Promise.resolve(),
    compile: async name => { const copy = copyOf(name); return copy.module ?? WebAssembly.compile(await copy.blob.arrayBuffer()); },
    bytes: async name => new Uint8Array(await copyOf(name).blob.arrayBuffer()),
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
