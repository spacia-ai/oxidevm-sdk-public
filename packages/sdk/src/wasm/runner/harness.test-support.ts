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
  /** The command's own arguments after the launch descriptor. */
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
  /** Replaces the launch argument, to model a missing or corrupt descriptor. */
  readonly argument?: string | null;
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
    args: argument === null ? [...(spec.args ?? [])] : [argument, ...(spec.args ?? [])],
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
      const bytes = spec.release.served.get(url);
      return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice()));
    },
    locks: spec.locks === null ? undefined : spec.locks ?? fakeLocks().locks,
    browser: spec.browser ?? ALL_FEATURES,
    importAdapter: async bytes => {
      imports.count += 1;
      const url = `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
      const namespace: unknown = await import(/* @vite-ignore */ url);
      return namespace;
    },
  };
  return { linux, done: runModule(context), fetched, imports };
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
