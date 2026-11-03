import type { RunnerCommandLaunch, RunnerCopies, RunnerHostLaunch } from "../../runtime/js-process/launch.js";
import type { SignalTransport } from "./signals.js";
import { fakeSignals } from "../testing/memory-signals.js";
import { encodeLaunchArgument } from "./descriptor.js";
import { fakeLinux, type FakeLinux } from "../testing/memory-linux.js";
import type { BrowserProbe } from "./prerequisites.js";
import { runModule, type RunnerContext } from "./run.js";
import type { Release } from "./fixtures.test-support.js";
import { MemoryNetwork, PASS_THROUGH_TLS } from "../net/memory-network.js";
import { moduleReach } from "../reach.js";

export const ALL_FEATURES: BrowserProbe = { crossOriginIsolated: true, indexedDB: true, jspi: true, webLocks: true };

export interface Launch {
  readonly release: Release;
  /** The command's own arguments: the whole argv the runner sees (the descriptor arrives in the start message). */
  readonly args?: readonly string[];
  readonly environment?: readonly string[];
  readonly cwd?: string;
  readonly paths?: Readonly<Record<string, number>>;
  readonly staleSockets?: readonly string[];
  readonly occupied?: readonly string[];
  readonly acceptFailures?: readonly number[];
  readonly existingFiles?: Readonly<Record<string, { readonly bytes: Uint8Array; readonly mode: number }>>;
  readonly writeFailure?: number;
  readonly browser?: BrowserProbe;
  /** Replaces the launch description of the start message, to model a missing or corrupt one. */
  readonly argument?: string | null;
  /** Starts the module as a program in the VM that ran one of its commands (engine ADR 0027); `args` is then the whole argv. */
  readonly command?: RunnerCommandLaunch;
  /** The process's signals; a fresh `fakeSignals()` unless given. */
  readonly signals?: SignalTransport;
  /** The VM network the module process sees; an empty local-only one with the module's reach unless given. */
  readonly network?: MemoryNetwork;
}

export interface Running {
  readonly linux: FakeLinux;
  readonly done: Promise<number>;
  /** Every non-blob: URL the runner or the adapter tried to fetch: the runner itself fetches nothing (ADR 0028). */
  readonly fetched: string[];
  readonly imports: { count: number };
  /** The worker scope the runner installed the module network into. */
  readonly scope: Record<string, unknown>;
}

/** Starts the runner against fakes. The copies come from the release's served bytes, as the VM's store would hold them. */
export function launch(spec: Launch): Running {
  const argument = spec.argument === undefined ? encodeLaunchArgument(spec.release.descriptor) : spec.argument;
  const linux = fakeLinux({
    args: [...(spec.args ?? [])],
    reach: moduleReach(spec.release.manifest.requires.host),
    ...(spec.environment === undefined ? {} : { environment: spec.environment }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    ...(spec.paths === undefined ? {} : { paths: spec.paths }),
    ...(spec.staleSockets === undefined ? {} : { staleSockets: spec.staleSockets }),
    ...(spec.occupied === undefined ? {} : { occupied: spec.occupied }),
    ...(spec.acceptFailures === undefined ? {} : { acceptFailures: spec.acceptFailures }),
    ...(spec.existingFiles === undefined ? {} : { existingFiles: spec.existingFiles }),
    ...(spec.writeFailure === undefined ? {} : { writeFailure: spec.writeFailure }),
  });
  const fetched: string[] = [], imports = { count: 0 }, scope: Record<string, unknown> = { XMLHttpRequest: {}, EventSource: {} };
  const network = spec.network ?? new MemoryNetwork(moduleReach(spec.release.manifest.requires.host));
  const context: RunnerContext = {
    ...linux,
    browser: spec.browser ?? ALL_FEATURES,
    importAdapter: async bundle => {
      imports.count += 1;
      const url = `data:text/javascript;base64,${Buffer.from(await bundle.arrayBuffer()).toString("base64")}`;
      const namespace: unknown = await import(/* @vite-ignore */ url);
      return namespace;
    },
    signals: spec.signals ?? fakeSignals(),
    network: { ports: { sockets: network.sockets(), sync: network.syncSockets(), tls: null }, scope, tls: PASS_THROUGH_TLS },
  };
  const done = (async () => {
    const start = spec.command ?? (argument === null ? undefined : await hostLaunch(spec.release, argument));
    const original = globalThis.fetch;
    // A blob: URL of a copy is the module's own; any other URL is a fetch the runner must never make.
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("blob:")) return original(input, init);
      fetched.push(url);
      return Promise.reject(new TypeError("Failed to fetch"));
    };
    try { return await runModule(context, start); } finally { globalThis.fetch = original; }
  })();
  return { linux, done, fetched, imports, scope };
}

/** The release's files as the VM's verified-copy store hands them over: a compiled module for each `.wasm` file. */
async function copiesOf(release: Release): Promise<RunnerCopies> {
  const served = (url: string): Uint8Array<ArrayBuffer> => release.served.get(url) ?? new Uint8Array();
  const artifacts = await Promise.all(Object.entries(release.descriptor.artifacts).map(async ([artifact, pin]) => {
    const bytes = served(pin.url);
    // A file that does not compile is kept as bytes, as the VM's store keeps it.
    const module = artifact.endsWith(".wasm") ? await WebAssembly.compile(bytes).catch(() => null) : null;
    return [artifact, { blob: new Blob([bytes]), module }] as const;
  }));
  return { adapter: new Blob([served(release.descriptor.adapter.url)], { type: "text/javascript" }), artifacts: Object.fromEntries(artifacts), tls: null };
}

/** `spawnModule`'s launch for `release` (engine ADR 0028): its description and the VM's verified copies. */
export async function hostLaunch(release: Release, descriptor = encodeLaunchArgument(release.descriptor)): Promise<RunnerHostLaunch> {
  return { kind: "host", descriptor, ...await copiesOf(release) };
}

/**
 * The launch the driver hands the runner when a program in the VM runs `name`: the release's files as the Userspace
 * worker verified them when the commands were turned on, a compiled module for each `.wasm` file.
 */
export async function commandLaunch(release: Release, name: string, terminals: RunnerCommandLaunch["terminals"] = { stdin: false, stdout: false, stderr: false }): Promise<RunnerCommandLaunch> {
  return { kind: "module-command", invocation: { name, path: `/usr/local/bin/${name}` }, terminals, descriptor: encodeLaunchArgument(release.descriptor), ...await copiesOf(release) };
}

/** The JSON records the runner wrote with an `oxidevm` key, in order. */
export function records(lines: readonly string[]): readonly Readonly<Record<string, unknown>>[] {
  return lines.flatMap(line => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "oxidevm" in parsed ? [Object.fromEntries(Object.entries(parsed))] : [];
    } catch { return []; }
  });
}
