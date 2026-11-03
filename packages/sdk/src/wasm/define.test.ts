import { describe, expect, it } from "vitest";
import type { NetConnectOptions, NetHost, ProcessSignals, RealtimeArrival, SignalTrap, TrappableSignal } from "./capabilities.js";
import type { RealtimeSignalNumber, SignalName } from "../runtime/process-signals.js";
import { defineModule } from "./define.js";
import type { CommandIO, Invocation, Terminals } from "./define.js";
import { moduleHandle } from "./handle.js";
import type { CommandName, ModuleProcess, SpawnArgs } from "./handle.js";
import type { EndpointDecl, ModuleDecl } from "./manifest-types.js";
import type { FileDescriptor } from "../js-process-types.js";
import type { SystemVM, UserspaceVM } from "../contracts.js";
import type { enableModuleCommands, ModuleCommands, ModuleCommandsStatus } from "./commands.js";
import type { ModuleHandle } from "./handle.js";

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

/**
 * A command module that programs in the VM can run as `python3` or `python` once an application turns its commands on.
 * Declaring commands gives `main` how it was invoked and which descriptors are terminals; declaring `process.signals`
 * lets it trap Ctrl+C instead of being killed by it.
 */
const commanded = defineModule({
  manifest: {
    id: "py", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, commands: ["python3", "python"],
    requires: { host: ["files.sync", "process.signals"] }, license: { spdx: "MIT" },
  },
  adapter: host => {
    const signals: ProcessSignals = host.process.signals;
    return {
      async main(io) {
        const invocation: Invocation<"python" | "python3"> = io.invocation;
        const terminals: Terminals = io.terminals;
        const name: "python" | "python3" | undefined = invocation.kind === "command" ? invocation.name : undefined;
        const usage = invocation.kind === "command" ? `usage: ${invocation.argv0} FILE (${invocation.path})` : "usage: FILE";
        const trap: SignalTrap = await signals.trap(["SIGINT", "SIGTERM"]);
        const interrupt: Int32Array = trap.interruptBuffer;
        const trapped: readonly TrappableSignal[] = trap.signals;
        for await (const signal of trap) {
          const received: TrappableSignal = signal;
          void received;
          break;
        }
        await trap.untrap();
        // Real-time signals by name or number: a standard signal yields its name, a real-time one its arrival.
        const mixed = await signals.trap(["SIGINT", "SIGRTMIN+1", 40]);
        const listed: readonly (TrappableSignal | RealtimeSignalNumber)[] = mixed.signals;
        for await (const arrival of mixed) {
          if (typeof arrival === "string") {
            const standard: "SIGINT" = arrival;
            // @ts-expect-error a standard signal carries no value; only a real-time arrival does
            void arrival.value;
            void standard;
          } else {
            const queued: RealtimeArrival = arrival;
            const value: bigint = arrival.value;
            void queued; void value;
          }
          break;
        }
        // @ts-expect-error SIGKILL can never be caught
        await signals.trap(["SIGKILL"]);
        // @ts-expect-error SIGSTOP can never be caught
        await signals.trap(["SIGSTOP"]);
        // @ts-expect-error SIGRTMIN+30 is past SIGRTMAX (64)
        await signals.trap(["SIGRTMIN+30"]);
        // @ts-expect-error SIGKILL can never be blocked
        await signals.block(["SIGKILL"]);
        const previous: ReadonlySet<SignalName> = await signals.block(["SIGINT", "SIGRTMAX"]);
        await signals.unblock([...previous].filter(name => name === "SIGINT"));
        const waiting: ReadonlySet<SignalName> = await signals.pending();
        void listed; void waiting;
        if (terminals.stdin && io.args.length === 0) await signals.raise("SIGINT");
        return usage.length + interrupt.length + trapped.length + (name === undefined ? 0 : 1);
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
      // @ts-expect-error no reach token (net.vm or net.internet) was declared, so host.net does not exist
      void host.net;
      return { main: () => 0 };
    },
  });
  // A reach token gives host.net; net.internet may disclose its hosts and purpose (engine ADR 0029).
  defineModule({
    manifest: {
      id: "fetcher", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["net.internet", "sockets.connect"] },
      network: { hosts: ["pypi.org"], purpose: "Downloads packages" }, license: { spdx: "MIT" },
    },
    adapter: host => {
      const net: NetHost = host.net;
      const options: NetConnectOptions = { host: "pypi.org", port: 443, tls: true, alpn: ["http/1.1"] };
      void net.connect(options);
      void host.sockets;
      return { main: () => 0 };
    },
  });
  defineModule({
    manifest: {
      id: "vmonly", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["net.vm"] },
      // @ts-expect-error only a module with net.internet discloses network use
      network: { hosts: ["pypi.org"] }, license: { spdx: "MIT" },
    },
    adapter: () => ({ main: () => 0 }),
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
    // @ts-expect-error only a command module runs as a program, so a service cannot declare commands
    manifest: {
      id: "s", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "service" }, commands: ["s"], requires: { host: [] }, license: { spdx: "MIT" },
      expose: { sql: { kind: "unix", path: "/tmp/s.sock", protocol: "x/1" } },
    },
    // @ts-expect-error the invalid manifest also leaves the adapter with no valid shape
    adapter: () => ({ protocols: { sql: async () => {} } }),
  });
  defineModule({
    manifest: { id: "n", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["process.info"] }, license: { spdx: "MIT" } },
    adapter: host => ({
      main(io) {
        // @ts-expect-error a module without commands cannot read how it was invoked: a runner that predates commands never sets it
        void io.invocation;
        // @ts-expect-error nor which descriptors are terminals
        void io.terminals;
        // @ts-expect-error process.signals was not declared, so host.process has no signals member
        void host.process.signals;
        return 0;
      },
    }),
  });
  defineModule({
    manifest: { id: "t", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, commands: ["python3"], requires: { host: ["process.signals"] }, license: { spdx: "MIT" } },
    adapter: host => ({
      async main(io) {
        const { invocation } = io;
        if (invocation.kind === "command") {
          // @ts-expect-error only a declared name can be the command that ran, so io.invocation.name === "undeclared" cannot compile either
          const undeclared: typeof invocation.name = "undeclared";
          void undeclared;
        }
        // @ts-expect-error SIGKILL can never be trapped
        await host.process.signals.trap(["SIGKILL"]);
        return 0;
      },
    }),
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

const pins = { release: "0".repeat(64), adapter: { url: "/a.mjs", sha256: "1".repeat(64), bytes: 1 }, artifacts: {} };
/** What `oxidevm wasm stage` generates for a module with commands: module.json as a literal. */
const generated = moduleHandle({
  schemaVersion: 1, id: "py", version: "1.0.0", abi: "raw", adapter: { api: 1, sha256: "1".repeat(64), bytes: 1 }, artifacts: [],
  process: { kind: "command" }, commands: ["python", "python3"], requires: { host: [] }, license: { spdx: "MIT" },
}, pins);

/** Command names come from the manifest literal too; a handle whose manifest was loaded accepts any name for the runtime to check. */
export function commandContract(declared: CommandName<typeof commanded.manifest>, handled: CommandName<typeof generated.manifest>, plain: CommandIO, named: CommandIO<"python">): void {
  // Exactly the declared names, in both directions, for a module definition and for a generated handle.
  const onlyDeclared: "python" | "python3" = declared;
  const everyDeclared: readonly CommandName<typeof commanded.manifest>[] = ["python", "python3"];
  const onlyHandled: "python" | "python3" = handled;
  const everyHandled: readonly CommandName<typeof generated.manifest>[] = ["python", "python3"];
  // @ts-expect-error only declared names are command names
  const undeclared: CommandName<typeof commanded.manifest> = "node";
  // @ts-expect-error md2html declares no commands, so it has no command names
  const none: CommandName<typeof command.manifest> = "md2html";
  const loaded: CommandName<ModuleDecl> = "anything";
  // Without a type argument CommandIO is the shape every runner provides, and a command's io is one.
  const widened: CommandIO = named;
  const args: readonly string[] = plain.args;
  void [onlyDeclared, everyDeclared, onlyHandled, everyHandled, undeclared, none, loaded, widened, args];
}

const resolved = { schemaVersion: 1, version: "1.0.0", abi: "raw", adapter: { api: 1, sha256: "1".repeat(64), bytes: 1 }, artifacts: [], requires: { host: [] }, license: { spdx: "MIT" } } as const;
/** Generated handles of a command module with a required option, a command module without commands, and a service. */
const optioned = moduleHandle({
  ...resolved, id: "conv", process: { kind: "command" }, commands: ["conv"],
  options: { dataDir: { type: "string", maxLength: 64 }, mode: { type: "enum", values: ["a", "b"], default: "a" } },
}, pins);
const commandless = moduleHandle({ ...resolved, id: "plain", process: { kind: "command" } }, pins);
const generatedService = moduleHandle({ ...resolved, id: "db", process: { kind: "service" }, expose: { sql: { kind: "unix", path: "/tmp/db.sock", protocol: "x/1" } } }, pins);

/**
 * `enableModuleCommands`' contract, also never called: only a command module that declares commands turns them on,
 * `commands` names only declared ones, the options are the module's own (a required one is required), nothing that the
 * program running a command supplies itself (`args`, `cwd`, `env`) can be passed, and `paths` is typed by the names
 * the call turned on.
 */
export async function enableContract(enable: typeof enableModuleCommands, vm: UserspaceVM, system: SystemVM, loaded: ModuleHandle): Promise<void> {
  // Every declared command by default, each with its typed path.
  const all = await enable(vm, generated);
  const python: "/usr/local/bin/python" = all.paths.python;
  const names: readonly ("python" | "python3")[] = all.commands;
  const named: ModuleCommands<typeof generated.manifest> = all;
  // A subset narrows the names and the paths to the commands this call turned on.
  const one = await enable(vm, generated, { commands: ["python3"], concurrency: 2, signal: AbortSignal.timeout(1000) });
  const python3: "/usr/local/bin/python3" = one.paths.python3;
  const status: ModuleCommandsStatus<"python3"> = await one.status();
  // @ts-expect-error python was not turned on by this call, so it has no path
  void one.paths.python;
  // Options come from the manifest; the one without a default is required.
  await enable(vm, optioned, { options: { dataDir: "/workspace/data" } });
  // @ts-expect-error dataDir has no default, so the options argument is required
  await enable(vm, optioned);
  // @ts-expect-error a required option cannot be left out
  await enable(vm, optioned, { options: { mode: "b" } });
  // @ts-expect-error an enum option accepts only its declared values
  await enable(vm, optioned, { options: { dataDir: "/workspace/data", mode: "c" } });
  // @ts-expect-error a service runs no commands
  await enable(vm, generatedService);
  // @ts-expect-error a command module without commands has none to turn on
  await enable(vm, commandless);
  // @ts-expect-error only declared names can be turned on
  await enable(vm, generated, { commands: ["node"] });
  // @ts-expect-error the program that runs a command supplies its own arguments
  await enable(vm, generated, { args: ["x.py"] });
  // @ts-expect-error and its own working directory
  await enable(vm, generated, { cwd: "/workspace" });
  // @ts-expect-error and its own environment
  await enable(vm, generated, { env: { HOME: "/home/user" } });
  // @ts-expect-error a module that declares no options takes none
  await enable(vm, generated, { options: { mode: "a" } });
  // @ts-expect-error a System VM runs no module commands
  await enable(system, generated);
  // A loaded handle has no literal type: any names and options type-check, and the call checks them when it runs.
  const loose = await enable(vm, loaded, { commands: ["anything"], options: { mode: 1 } });
  const anything: "/usr/local/bin/anything" = loose.paths.anything;
  const every: Readonly<Record<string, string>> = (await enable(vm, loaded)).paths;
  void [python, names, named, python3, status, anything, every];
}

describe("module definitions", () => {
  it("returns the module unchanged so the build can read both halves", () => {
    expect(command.manifest.id).toBe("md2html");
    expect(commanded.manifest.commands).toEqual(["python3", "python"]);
    expect(generated.manifest.commands).toEqual(["python", "python3"]);
    expect(typeof command.adapter).toBe("function");
    expect(Object.keys(service.manifest.expose)).toEqual(["sql", "pg"]);
  });

  it("builds a handle that carries the manifest literal and the launch pins untouched", () => {
    const handle = moduleHandle(service.manifest, pins);
    expect(handle.manifest).toBe(service.manifest);
    expect(handle.pins).toBe(pins);
  });
});
