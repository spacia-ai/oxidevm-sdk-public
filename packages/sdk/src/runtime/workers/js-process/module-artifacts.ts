import type { RunnerHostLaunch, RunnerVerifiedFile } from "../../js-process/launch.js";
import { moduleReach, type ModuleReach } from "../../../wasm/reach.js";
import { parseLaunchArgument, type LaunchDescriptor } from "../../../wasm/runner/descriptor.js";
import { ADAPTER_FILE } from "../../../wasm/runner/pinned.js";
import { copyKey } from "../../protocol/userspace-module-files.js";
import type { CopyHolder, CopyRequest, ModuleCopies } from "./module-copies.js";
import { MODULE_PREREQUISITE_REASON, takeModuleLease, type LeaseLocks, type ModuleLease } from "./module-leases.js";
import { VMError } from "../../errors.js";
import { startsWithTls, TLS_FILE, tlsPin } from "../../../wasm/net/tls-file.js";
import type { ResolvedManifest } from "../../../wasm/manifest-types.js";

/**
 * A module start's view of the VM's verified copies (engine ADR 0028): the files a launch description pins, held for one
 * holder in the VM's store (`module-copies.ts`), typed for their blob: URLs. Every run of the module uses these copies,
 * so a file that changes on the server afterwards has no effect.
 */

export interface VerifiedModuleFiles {
  /** The adapter bundle, typed as JavaScript so the runner can import it from a blob: URL. */
  readonly adapter: Blob;
  readonly artifacts: Readonly<Record<string, RunnerVerifiedFile>>;
  /** The engine's TLS module, for a module with a network reach (engine ADR 0029); null otherwise. */
  readonly tls: RunnerVerifiedFile | null;
}

/** Reads the files the VM lacks, by key; nothing else. */
export type ModuleFileSupply = (files: readonly CopyRequest[], signal: AbortSignal) => Promise<ReadonlyMap<string, Blob>>;

export interface ModuleFileSources {
  readonly copies: ModuleCopies;
  readonly supply: ModuleFileSupply;
}

/** The files of a launch description, the adapter first, each with the name failures report in `detail.file`. */
export function moduleFileRequests(descriptor: LaunchDescriptor): CopyRequest[] {
  return [{ file: ADAPTER_FILE, pin: descriptor.adapter }, ...Object.entries(descriptor.artifacts).map(([file, pin]) => ({ file, pin }))];
}

/** The engine files a module starts with beyond its own: the TLS module when it has a network reach (engine ADR 0029). */
export function engineFileRequests(descriptor: LaunchDescriptor): CopyRequest[] {
  return startsWithTls(moduleReach(descriptor.manifest.requires.host)) ? [{ file: TLS_FILE, pin: tlsPin() }] : [];
}

/** The media types the browser checks when a copy is loaded through its blob: URL: module scripts and streaming compiles. */
export function mediaType(name: string): string {
  if (name.endsWith(".wasm")) return "application/wasm";
  return /\.(?:m|c)?js$/u.test(name) ? "text/javascript" : "";
}

/**
 * Holds every file of `descriptor` for `holder`: the budget is checked from the pins first, then the files the VM lacks
 * are supplied and checked once. A file that cannot be read is CORE_LOAD_FAILED `wasm-module-artifact` and one that does
 * not match its pin GUEST_CRASH `wasm-module-integrity`, each naming the file in `detail.file`; the holder then holds
 * nothing new.
 */
export async function holdModuleFiles(descriptor: LaunchDescriptor, holder: CopyHolder, sources: ModuleFileSources, signal: AbortSignal): Promise<VerifiedModuleFiles> {
  const own = moduleFileRequests(descriptor), engine = engineFileRequests(descriptor), requests = [...own, ...engine], { copies } = sources;
  copies.assertFits(requests);
  const lacking = new Set<string>(copies.missing(requests.map(request => request.pin)));
  const supplied = await sources.supply(requests.filter(request => lacking.has(copyKey(request.pin))), signal);
  const held = await copies.hold(holder, requests, supplied, signal);
  const copyOf = (request: CopyRequest): Blob => held.get(copyKey(request.pin)) ?? new Blob();
  const [adapter, ...artifacts] = own, tls = engine[0];
  const files: Record<string, RunnerVerifiedFile> = {};
  // Compiled modules never cross the module frame boundary: its broker compiles each core module once per VM (ADR 0028).
  for (const request of artifacts) files[request.file] = Object.freeze({ blob: new Blob([copyOf(request)], { type: mediaType(request.file) }), module: null });
  return Object.freeze({
    adapter: new Blob([adapter === undefined ? new Blob() : copyOf(adapter)], { type: "text/javascript" }), artifacts: Object.freeze(files),
    tls: tls === undefined ? null : Object.freeze({ blob: new Blob([copyOf(tls)], { type: "application/wasm" }), module: null }),
  });
}

/** The files a page supplied with a start or an enable, by key, as the store takes them. */
export function suppliedFiles(files: Readonly<Record<string, Blob>>): ModuleFileSupply {
  const supplied: ReadonlyMap<string, Blob> = new Map(Object.entries(files));
  return () => Promise.resolve(supplied);
}

/**
 * Refuses a module the module frame cannot run (ADR 0028): the frame's opaque origin has no IndexedDB and no Web Locks,
 * so a manifest whose `requires.browser` names either is FEATURE_NOT_AVAILABLE `wasm-module-prerequisite` before anything
 * is read or started.
 */
export function assertRunsInModuleFrame(manifest: ResolvedManifest): void {
  const missing = (manifest.requires.browser ?? []).filter(feature => feature === "indexeddb" || feature === "web-locks");
  if (missing.length > 0) throw new VMError("FEATURE_NOT_AVAILABLE", `${manifest.id} needs ${missing.join(" and ")}, which isolated module workers do not have`, { reason: MODULE_PREREQUISITE_REASON, missing: missing.map(feature => `browser feature ${feature}`) });
}

/** `spawnModule`'s start before admission: the runner's launch, and the workspace lease of an exclusive service. */
/** `spawnModule`'s start: the runner's launch, an exclusive service's lease, and the network reach Rust gives the process (engine ADR 0029). */
export interface ModuleStart { readonly launch: RunnerHostLaunch; readonly lease: ModuleLease | undefined; readonly reach: ModuleReach }

/**
 * Prepares `spawnModule`'s start (engine ADR 0028). An exclusive service's workspace lease comes first, so a busy one is
 * refused before any file is read; then the description's copies are held for the VM's spawn holder, which keeps them
 * until the VM goes, so the next start supplies nothing. A description that does not parse is INVALID_ARGUMENT. On any
 * failure the lease is released.
 */
export async function prepareModuleStart(descriptor: string, files: Readonly<Record<string, Blob>>, sources: Omit<ModuleFileSources, "supply"> & { readonly locks: LeaseLocks | undefined }, signal: AbortSignal): Promise<ModuleStart> {
  const parsed = parseLaunchArgument(descriptor);
  assertRunsInModuleFrame(parsed.manifest);
  const lease = await takeModuleLease(parsed, sources.locks);
  try {
    const copies = await holdModuleFiles(parsed, { kind: "spawn" }, { copies: sources.copies, supply: suppliedFiles(files) }, signal);
    return { launch: { kind: "host", descriptor, adapter: copies.adapter, artifacts: copies.artifacts, tls: copies.tls }, lease, reach: moduleReach(parsed.manifest.requires.host) };
  } catch (error: unknown) { lease?.release(); throw error; }
}
