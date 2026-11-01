import type { RunnerCommandLaunch } from "../../runtime/js-process/launch.js";
import { LinuxError } from "../../runtime/js-process/codec.js";
import type { SignalDisposition, TrappableSignalNumber } from "../../runtime/js-process/signals.js";
import type { SignalTransport } from "./signals.js";
import { encodeLaunchArgument } from "./descriptor.js";
import { fakeLinux, type FakeLinux } from "./linux.test-support.js";
import type { BrowserProbe } from "./prerequisites.js";
import { runModule, type RunnerContext } from "./run.js";
import type { Release } from "./fixtures.test-support.js";

/** Web Locks with `ifAvailable` semantics: a held name yields `null` to the callback. */
export function fakeLocks(held = new Set<string>()): { readonly held: Set<string>; readonly locks: NonNullable<RunnerContext["locks"]> } {
  const locks: NonNullable<RunnerContext["locks"]> = {
    request: async (name: string, ...rest: unknown[]): Promise<unknown> => {
      const callback = rest.at(-1);
      if (typeof callback !== "function") throw new Error("a lock callback is required");
      if (held.has(name)) return Reflect.apply(callback, undefined, [null]);
      held.add(name);
      try { return await Reflect.apply(callback, undefined, [{ name, mode: "exclusive" }]); } finally { held.delete(name); }
    },
  };
  return { held, locks };
}

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
  readonly locks?: RunnerContext["locks"] | null;
  /** Replaces the launch description of the start message, to model a missing or corrupt one. */
  readonly argument?: string | null;
  /** Starts the module as a program in the VM that ran one of its commands (engine ADR 0027); `args` is then the whole argv. */
  readonly command?: RunnerCommandLaunch;
  /** Replaces the server of the release's files. */
  readonly fetch?: (url: string) => Promise<Response>;
  /** The process's signals; a fresh `fakeSignals()` unless given. */
  readonly signals?: SignalTransport;
}

export interface Running {
  readonly linux: FakeLinux;
  readonly done: Promise<number>;
  readonly fetched: string[];
  readonly imports: { count: number };
}

/** Starts the runner against fakes. The served files come from the release, so hashes are real. */
export function launch(spec: Launch): Running {
  const argument = spec.argument === undefined ? encodeLaunchArgument(spec.release.descriptor) : spec.argument;
  const linux = fakeLinux({
    args: [...(spec.args ?? [])],
    ...(spec.environment === undefined ? {} : { environment: spec.environment }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    ...(spec.paths === undefined ? {} : { paths: spec.paths }),
    ...(spec.staleSockets === undefined ? {} : { staleSockets: spec.staleSockets }),
    ...(spec.occupied === undefined ? {} : { occupied: spec.occupied }),
    ...(spec.acceptFailures === undefined ? {} : { acceptFailures: spec.acceptFailures }),
    ...(spec.existingFiles === undefined ? {} : { existingFiles: spec.existingFiles }),
    ...(spec.writeFailure === undefined ? {} : { writeFailure: spec.writeFailure }),
  });
  const fetched: string[] = [], imports = { count: 0 };
  const context: RunnerContext = {
    ...linux,
    fetch: (url) => {
      fetched.push(url);
      if (spec.fetch !== undefined) return spec.fetch(url);
      const bytes = spec.release.served.get(url);
      return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice()));
    },
    locks: spec.locks === null ? undefined : spec.locks ?? fakeLocks().locks,
    browser: spec.browser ?? ALL_FEATURES,
    importAdapter: async bundle => {
      imports.count += 1;
      const url = `data:text/javascript;base64,${Buffer.from(await bundle.arrayBuffer()).toString("base64")}`;
      const namespace: unknown = await import(/* @vite-ignore */ url);
      return namespace;
    },
    signals: spec.signals ?? fakeSignals(),
  };
  return { linux, done: runModule(context, spec.command ?? (argument === null ? undefined : { kind: "host", descriptor: argument })), fetched, imports };
}

/**
 * The launch the driver hands the runner when a program in the VM runs `name`: the release's files as the Userspace
 * worker verified them when the commands were turned on, a compiled module for each `.wasm` file.
 */
export async function commandLaunch(release: Release, name: string, terminals: RunnerCommandLaunch["terminals"] = { stdin: false, stdout: false, stderr: false }): Promise<RunnerCommandLaunch> {
  const served = (url: string): Uint8Array<ArrayBuffer> => release.served.get(url) ?? new Uint8Array();
  const artifacts = await Promise.all(Object.entries(release.descriptor.artifacts).map(async ([artifact, pin]) => {
    const bytes = served(pin.url);
    return [artifact, { blob: new Blob([bytes]), module: artifact.endsWith(".wasm") ? await WebAssembly.compile(bytes) : null }] as const;
  }));
  return {
    kind: "module-command", invocation: { name, path: `/usr/local/bin/${name}` }, terminals, descriptor: encodeLaunchArgument(release.descriptor),
    adapter: new Blob([served(release.descriptor.adapter.url)], { type: "text/javascript" }), artifacts: Object.fromEntries(artifacts),
  };
}

/**
 * A process's signals with the test playing Rust: each disposition is recorded and answered with the previous one (an
 * `ignored` signal starts as "ignore"; a `refuse`d one fails with EOPNOTSUPP), `deliver` hands signals to the listener,
 * `release` answers the oldest held disposition when `deferred`, and `exits` lists the signals the process ended by.
 */
export function fakeSignals(options: { readonly ignored?: readonly TrappableSignalNumber[]; readonly refuse?: readonly TrappableSignalNumber[]; readonly deferred?: boolean } = {}) {
  const dispositions = new Map<TrappableSignalNumber, SignalDisposition>((options.ignored ?? []).map(signal => [signal, "ignore"]));
  const calls: [TrappableSignalNumber, SignalDisposition][] = [], exits: TrappableSignalNumber[] = [], refused = new Set(options.refuse ?? []), held: (() => void)[] = [];
  const listening: { listener?: (signals: readonly TrappableSignalNumber[]) => void; count: number } = { count: 0 };
  const transport: SignalTransport = {
    setDisposition: async (signal, disposition) => {
      calls.push([signal, disposition]);
      if (options.deferred === true) await new Promise<void>(resolve => { held.push(resolve); });
      if (refused.has(signal)) throw new LinuxError(95);
      const previous = dispositions.get(signal) ?? "default";
      dispositions.set(signal, disposition);
      return previous;
    },
    listen: listener => { listening.listener = listener; listening.count += 1; },
    interruptWord: new Int32Array(new SharedArrayBuffer(8)).subarray(1, 2),
    signaled: signal => { exits.push(signal); },
  };
  return {
    ...transport, calls, exits, dispositions, refused,
    get listeners() { return listening.count; },
    deliver: (signals: readonly TrappableSignalNumber[]) => { listening.listener?.(signals); },
    release: () => { held.shift()?.(); },
  };
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
