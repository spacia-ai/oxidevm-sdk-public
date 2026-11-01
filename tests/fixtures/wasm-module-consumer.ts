import { MODULE_EXIT, classifyLicense, decodeModuleManifest, defineModule, encodeModuleManifest, isServiceDecl, moduleHandle, spawnModule, stopModule } from "@oxidevm/sdk/wasm";
import type { Connection, Gate, ModuleHandle, ModuleProcess, SpawnArgs } from "@oxidevm/sdk/wasm";
import type { ProcessExit, SystemVM, UserspaceVM } from "@oxidevm/sdk";

declare function render(markdown: string): string;
declare function openDatabase(path: string): { query(sql: string): Promise<readonly string[]>; close(): void };

/** A command module: a typed manifest plus one adapter factory whose host is narrowed by `requires.host`. */
export const command = defineModule({
  manifest: {
    id: "md2html",
    version: "1.0.0",
    abi: "bindgen",
    artifacts: [{ name: "markdown.wasm", from: "pkg/markdown_bg.wasm" }],
    process: { kind: "command" },
    requires: { host: ["files.sync"] },
    license: { spdx: "MIT" },
  },
  adapter: async host => {
    const compiled = await host.artifacts.compile("markdown.wasm");
    return {
      main(io) {
        const [input, output] = io.args;
        if (input === undefined || output === undefined) return host.fail(2, "usage: md2html <in.md> <out.html>");
        host.fs.writeFile(output, new TextEncoder().encode(render(new TextDecoder().decode(host.fs.readFile(input)))));
        return compiled instanceof WebAssembly.Module ? 0 : MODULE_EXIT.adapterMax;
      },
    };
  },
});

/** A service module: `protocols` must have exactly the keys of `expose`. */
export const service = defineModule({
  manifest: {
    id: "pglite",
    version: "1.0.0",
    abi: "emscripten",
    artifacts: [{ name: "pglite.wasm", from: "upstream/pglite.wasm" }],
    process: { kind: "service", exclusive: "workspace" },
    expose: {
      sql: { kind: "unix", path: "/workspace/_oxidevm/pglite.sock", protocol: "oxidevm-sql/1" },
      pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" },
    },
    requires: { host: ["files.sync"] },
    options: {
      durability: { type: "enum", values: ["relaxed", "strict"], default: "strict" },
      dataDir: { type: "string", maxLength: 128 },
      packages: { type: "enum-set", values: ["pandas", "matplotlib"], default: ["pandas"] },
    },
    license: { spdx: "Apache-2.0" },
  },
  adapter: host => {
    const strict: "relaxed" | "strict" = host.options.durability;
    const packages: readonly ("pandas" | "matplotlib")[] = host.options.packages;
    const database = openDatabase(host.options.dataDir);
    const errno: number = host.kit.errno.toEmscripten(2);
    const gate: Gate = host.kit.gate();
    void [strict, packages, host.artifacts.url("pglite.wasm"), errno, gate, host.stdio.stdout];
    return {
      info: async () => ({ rows: (await database.query("select 1")).length }),
      protocols: {
        sql: async (connection: Connection) => { await connection.write(new TextEncoder().encode((await database.query("select 1")).join())); },
        pg: async (connection: Connection) => { await connection.write(await connection.read(1)); },
      },
      close: () => { database.close(); },
    };
  },
});

/** Author-side negatives: each rejected shape is paired with the accepted ones above. */
export function authorContract(): void {
  defineModule({
    manifest: { id: "a", version: "1.0.0", abi: "wasi", artifacts: [], process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" } },
    adapter: host => {
      // @ts-expect-error sockets.connect was not declared in requires.host, so host.sockets does not exist
      void host.sockets;
      // @ts-expect-error the undeclared files.async capability hides host.files
      void host.files;
      // @ts-expect-error artifact names are checked against the manifest
      void host.artifacts.url("unknown.wasm");
      return { main: () => 0 };
    },
  });
  defineModule({
    manifest: {
      id: "c", version: "1.0.0", abi: "emscripten", artifacts: [], process: { kind: "service" }, requires: { host: [] }, license: { spdx: "MIT" },
      expose: { sql: { kind: "unix", path: "/tmp/c.sock", protocol: "x/1" }, pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" } },
    },
    // @ts-expect-error the pg endpoint has no handler
    adapter: () => ({ protocols: { sql: async () => {} } }),
  });
  defineModule({
    // @ts-expect-error a typo in a capability name is rejected
    manifest: { id: "e", version: "1.0.0", abi: "wasi", artifacts: [], process: { kind: "command" }, requires: { host: ["files.syncc"] }, license: { spdx: "MIT" } },
    // @ts-expect-error the invalid manifest also leaves the adapter with no valid shape
    adapter: () => ({ main: () => 0 }),
  });
}

/** Consumer-side contract: spawn options and endpoints come from the manifest literal. */
export function consumerContract(running: ModuleProcess<typeof service.manifest>): void {
  const pins = { release: "0".repeat(64), adapter: { url: "/a.mjs", sha256: "1".repeat(64), bytes: 1 }, artifacts: {} };
  const handle = moduleHandle(service.manifest, pins);
  const id: "pglite" = handle.manifest.id;
  const commandArgs: SpawnArgs<typeof command.manifest> = [{ args: ["README.md", "README.html"], cwd: "/workspace" }];
  const noArgs: SpawnArgs<typeof command.manifest> = [];
  const serviceArgs: SpawnArgs<typeof service.manifest> = [{ workspaceId: "workspace-1", options: { dataDir: "/workspace/pgdata", packages: ["matplotlib"] } }];
  // @ts-expect-error a service has no args or cwd
  const serviceWithArgs: SpawnArgs<typeof service.manifest> = [{ workspaceId: "w", options: { dataDir: "/x" }, args: ["x"] }];
  // @ts-expect-error an exclusive service needs the workspace id and the option without a default
  const missingRequired: SpawnArgs<typeof service.manifest> = [{}];
  // @ts-expect-error enum options accept only declared values
  const invalidEnum: SpawnArgs<typeof service.manifest> = [{ workspaceId: "w", options: { dataDir: "/x", durability: "paranoid" } }];
  // @ts-expect-error a command module declares no options
  const commandWithOptions: SpawnArgs<typeof command.manifest> = [{ options: { anything: true } }];
  const port: 5432 = running.endpoints.pg.port;
  const kind: "tcp" = running.endpoints.pg.kind;
  // @ts-expect-error only declared endpoints exist
  void running.endpoints.missing;
  void [id, commandArgs, noArgs, serviceArgs, serviceWithArgs, missingRequired, invalidEnum, commandWithOptions, port, kind];
}

/** Tooling-side helpers: strict decoders and the license classifier. */
export function toolingContract(bytes: Uint8Array): void {
  const resolved = decodeModuleManifest(bytes);
  const again: Uint8Array = encodeModuleManifest(resolved);
  const copyleft: boolean = classifyLicense(resolved.license.spdx).copyleft;
  const isService: boolean = isServiceDecl(resolved);
  const adapterLimit: 119 = MODULE_EXIT.adapterMax;
  void [again, copyleft, isService, adapterLimit];
}

/** Starting modules: precise for a generated handle, permissive for a loaded one, and only on a Userspace VM. */
export async function spawnContract(vm: UserspaceVM, system: SystemVM, loaded: ModuleHandle): Promise<ProcessExit> {
  const pins = { release: "0".repeat(64), adapter: { url: "https://app.test/a.mjs", sha256: "1".repeat(64), bytes: 1 }, artifacts: {} };
  const generated = moduleHandle(service.manifest, pins);
  const database = await spawnModule(vm, generated, { workspaceId: "workspace-1", options: { dataDir: "/workspace/pgdata" } });
  const port: 5432 = database.endpoints.pg.port;
  const version: string | number | boolean | undefined = database.info["version"];
  // @ts-expect-error a generated handle rejects an option its manifest does not declare
  await spawnModule(vm, generated, { workspaceId: "workspace-1", options: { dataDir: "/x", surprise: true } });
  const tool = await spawnModule(vm, moduleHandle(command.manifest, pins), { args: ["a.md", "a.html"], cwd: "/workspace" });
  const anything = await spawnModule(vm, loaded, { workspaceId: "w", args: ["x"], options: { any: 1 } });
  const maybe: Readonly<Record<string, unknown>> | undefined = anything.endpoints;
  // @ts-expect-error a system VM has no spawnJS, so it cannot host a module
  await spawnModule(system, generated, { workspaceId: "w", options: { dataDir: "/x" } });
  void [port, version, tool, maybe];
  return stopModule(database);
}
