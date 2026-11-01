import { vi } from "vitest";
import { Reader, Writer } from "../../js-process/codec.js";
import type { ModuleCommandEntry } from "../../userspace-module-commands-abi.js";
import { encodeLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION, type Release } from "../../../wasm/runner/fixtures.test-support.js";
import type { Fetcher } from "../../../wasm/runner/pinned.js";
import { ModuleCommands, type ModuleCommandsPorts, type ModuleCommandTableRuntime } from "./module-commands.js";

/** The smallest WebAssembly core module: magic and version 1. */
export const WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

/** A command module that declares `commands`, with a Wasm artifact and a data file. */
export function commandRelease(commands: readonly string[] = ["alpha", "beta"], extras: Partial<Parameters<typeof buildRelease>[0]> = {}): Promise<Release> {
  return buildRelease({
    adapter: "export default () => ({ main: () => 0 });",
    artifacts: { "tool.wasm": WASM, "data.bin": Uint8Array.of(1, 2, 3, 4) },
    declaration: { ...COMMAND_DECLARATION, commands },
    ...extras,
  });
}

/** The page's enable request for `release`, all of its commands unless named. */
export function enableRequest(release: Release, commands: readonly string[] = release.manifest.commands ?? [], concurrency = 4) {
  return { operation: "enable", descriptor: encodeLaunchArgument(release.descriptor), commands, concurrency } as const;
}

/** A server for the release's files that counts fetches per URL; `served` may be changed later to model a new deployment. */
export function server(release: Release) {
  const served = new Map(release.served), fetched: string[] = [];
  const fetch: Fetcher = url => {
    fetched.push(url);
    const bytes = served.get(url);
    return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice()));
  };
  return { served, fetched, fetch };
}

/** What a fake runtime answers instead of applying: an OXMA outcome code with its fields. */
export interface Refusal { readonly outcome: number; readonly entry?: number; readonly errno?: number; readonly changed?: boolean }

/**
 * A runtime whose apply export mirrors the engine's (`runtime/module_commands/apply.rs`): it reads the OXMC table, keeps
 * a stub for each name whose path is free, leaves a path held by another file alone and reports it, removes stubs no
 * longer named, and answers OXMA v1. `refuse` makes the next applications fail with that outcome instead.
 */
export function fakeTable(occupied: Iterable<string> = []) {
  const files = new Set(occupied), stubs = new Set<string>(), tables: ModuleCommandEntry[][] = [];
  const state = { refuse: undefined as Refusal | undefined };
  const answer = ({ outcome, entry = 0xffff_ffff, errno = 0, changed = false }: Refusal, skipped: readonly number[] = []) => {
    const writer = new Writer().raw(new TextEncoder().encode("OXMA")).u32(1).u8(outcome).u8(changed ? 1 : 0).u32(entry).u32(errno).u32(skipped.length);
    for (const index of skipped) writer.u32(index).u8(1);
    return writer.finish();
  };
  const runtime: ModuleCommandTableRuntime = {
    applyTable(request) {
      const r = new Reader(request);
      if (new TextDecoder().decode(r.raw(4)) !== "OXMC" || r.u32() !== 1) throw new Error("not an OXMC v1 table");
      const entries = Array.from({ length: r.u32() }, (): ModuleCommandEntry => ({ registration: r.u32(), concurrency: r.u32(), name: new TextDecoder().decode(r.raw(r.u32())) }));
      r.end();
      tables.push(entries);
      if (state.refuse !== undefined) return answer(state.refuse);
      const names = new Set(entries.map(entry => entry.name)), skipped: number[] = [];
      let changed = false;
      for (const [index, entry] of entries.entries()) {
        if (files.has(entry.name)) skipped.push(index);
        else if (!stubs.has(entry.name)) { stubs.add(entry.name); changed = true; }
      }
      for (const name of [...stubs]) if (!names.has(name)) { stubs.delete(name); changed = true; }
      return answer({ outcome: 0, changed }, skipped);
    },
  };
  return { runtime, files, stubs, tables, state };
}

/** An owner with a mounted runtime in a cross-origin isolated page, its ports spied on. */
export function owner(fetch: Fetcher, table = fakeTable(), overrides: Partial<ModuleCommandsPorts> = {}) {
  const ports = {
    runtime: vi.fn((): ModuleCommandTableRuntime | undefined => table.runtime),
    environment: vi.fn(() => ({ crossOriginIsolated: true, initialUser: "user" as const })),
    fetch,
    changed: vi.fn(),
    ...overrides,
  } satisfies ModuleCommandsPorts;
  return { commands: new ModuleCommands(ports), ports, table };
}

/** Runs `request` without cancellation. */
export const live = (): AbortSignal => new AbortController().signal;
