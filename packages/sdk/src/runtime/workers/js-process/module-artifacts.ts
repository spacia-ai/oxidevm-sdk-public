import type { RunnerVerifiedFile } from "../../js-process/launch.js";
import type { LaunchDescriptor } from "../../../wasm/runner/descriptor.js";
import { ADAPTER_FILE, loadPinned, type Fetcher } from "../../../wasm/runner/pinned.js";

/**
 * Verify-once copies of an enabled module's files (engine ADR 0027). Turning a module's commands on fetches every
 * pinned file once, checks its size and sha256, and keeps it as an immutable Blob; each WebAssembly core module is
 * compiled once. Every run of the commands uses these copies, so a file that changes on the server afterwards has no
 * effect, and nothing is fetched or hashed again until the commands are turned off and on.
 */

export interface VerifiedModuleFiles {
  /** The adapter bundle, typed as JavaScript so the runner can import it from a blob: URL. */
  readonly adapter: Blob;
  readonly artifacts: Readonly<Record<string, RunnerVerifiedFile>>;
  /** What the copies hold: every pin's size. */
  readonly bytes: number;
}

export interface ModuleFileSources {
  readonly fetch: Fetcher;
  /** Compiles a WebAssembly core module; the browser's compiler unless a test supplies one. */
  readonly compile?: (bytes: Uint8Array<ArrayBuffer>) => Promise<WebAssembly.Module>;
}

/** The bytes a release's pins claim. A verified copy is exactly that large, so budgets are checked before any fetch. */
export function pinnedBytes(descriptor: LaunchDescriptor): number {
  return Object.values(descriptor.artifacts).reduce((total, pin) => total + pin.bytes, descriptor.adapter.bytes);
}

/** A WebAssembly core module (magic and version 1). Component binaries carry another version and are never compiled. */
const CORE_MODULE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] as const;

function isCoreModule(bytes: Uint8Array): boolean {
  return bytes.length >= CORE_MODULE.length && CORE_MODULE.every((byte, index) => bytes[index] === byte);
}

/** The media types the browser checks when a copy is loaded through its blob: URL: module scripts and streaming compiles. */
function mediaType(name: string): string {
  if (name.endsWith(".wasm")) return "application/wasm";
  return /\.(?:m|c)?js$/u.test(name) ? "text/javascript" : "";
}

/**
 * A compile failure is not the enable's failure: the module may never compile that file, and an adapter that does gets
 * the same error from the verified bytes at run time, as it would when the application starts it.
 */
async function compiledOrNull(compile: NonNullable<ModuleFileSources["compile"]>, bytes: Uint8Array<ArrayBuffer>): Promise<WebAssembly.Module | null> {
  try { return await compile(bytes); } catch { return null; }
}

/**
 * Fetches and checks the adapter and every artifact once, in turn, so at most one file is in flight. A file that cannot be
 * fetched is CORE_LOAD_FAILED `wasm-module-artifact` and one that does not match its pin GUEST_CRASH
 * `wasm-module-integrity`, each naming the file in `detail.file`; nothing is kept then.
 */
export async function verifyModuleFiles(descriptor: LaunchDescriptor, sources: ModuleFileSources, signal: AbortSignal): Promise<VerifiedModuleFiles> {
  const compile = sources.compile ?? (bytes => WebAssembly.compile(bytes));
  const adapter = new Blob([await loadPinned(descriptor.adapter, "The adapter bundle", ADAPTER_FILE, sources.fetch, signal)], { type: "text/javascript" });
  const artifacts: Record<string, RunnerVerifiedFile> = {};
  for (const [name, pin] of Object.entries(descriptor.artifacts)) {
    const bytes = await loadPinned(pin, `Artifact ${name}`, name, sources.fetch, signal);
    const module = isCoreModule(bytes) ? await compiledOrNull(compile, bytes) : null;
    artifacts[name] = Object.freeze({ blob: new Blob([bytes], { type: mediaType(name) }), module });
  }
  return Object.freeze({ adapter, artifacts: Object.freeze(artifacts), bytes: pinnedBytes(descriptor) });
}
