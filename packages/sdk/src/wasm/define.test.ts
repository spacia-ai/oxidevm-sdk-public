import { describe, expect, it } from "vitest";
import { defineModule } from "./define.js";
import { moduleHandle } from "./handle.js";
import type { ModuleProcess, SpawnArgs } from "./handle.js";
import type { EndpointDecl, ModuleDecl } from "./manifest-types.js";
import type { FileDescriptor } from "../js-process-types.js";

declare function render(markdown: string): string;
declare function openDatabase(path: string): { query(sql: string): Promise<readonly string[]>; close(): void };

const command = defineModule({
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
        return compiled instanceof WebAssembly.Module ? 0 : 1;
      },
    };
  },
});

const service = defineModule({
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
    const code: number = host.kit.errno.toEmscripten(2);
    const out: FileDescriptor = host.stdio.stdout;
    void [strict, packages, host.artifacts.url("pglite.wasm"), code, out];
    return {
      info: async () => ({ rows: (await database.query("select 1")).length }),
      protocols: {
        sql: async connection => { await connection.write(new TextEncoder().encode((await database.query("select 1")).join())); },
        pg: async connection => { await connection.write(await connection.read(1)); },
      },
      close: () => { database.close(); },
    };
  },
});

/**
 * Compile-time contract: each rejected shape sits beside the accepted ones above. It is never called.
 * TypeScript does not check excess properties on an object returned from a function, so an extra handler
 * is caught by the runner at start (exit status 123), while a missing handler is rejected here.
 */
export function typeContract(): void {
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

/** Consumer-side contract, also never called: arguments and endpoints come from the manifest literal. */
export function consumerContract(running: ModuleProcess<typeof service.manifest>, dynamic: ModuleProcess<ModuleDecl>): void {
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
  // A handle whose manifest was loaded rather than generated has no literal type: everything is allowed, nothing is derived.
  const erased: SpawnArgs<ModuleDecl> = [{ args: ["a"], cwd: "/workspace", workspaceId: "w", options: { anything: 1 } }];
  const erasedNone: SpawnArgs<ModuleDecl> = [];
  // @ts-expect-error even an erased handle needs a real AbortSignal
  const erasedBadSignal: SpawnArgs<ModuleDecl> = [{ signal: "x" }];
  const endpoints: Readonly<Record<string, EndpointDecl>> | undefined = dynamic.endpoints;
  void [commandArgs, noArgs, serviceArgs, serviceWithArgs, missingRequired, invalidEnum, commandWithOptions, port, kind, erased, erasedNone, erasedBadSignal, endpoints];
}

describe("module definitions", () => {
  it("returns the module unchanged so the build can read both halves", () => {
    expect(command.manifest.id).toBe("md2html");
    expect(typeof command.adapter).toBe("function");
    expect(Object.keys(service.manifest.expose)).toEqual(["sql", "pg"]);
  });

  it("builds a handle that carries the manifest literal and the launch pins untouched", () => {
    const pins = { release: "0".repeat(64), adapter: { url: "/a.mjs", sha256: "1".repeat(64), bytes: 1 }, artifacts: {} };
    const handle = moduleHandle(service.manifest, pins);
    expect(handle.manifest).toBe(service.manifest);
    expect(handle.pins).toBe(pins);
  });
});
