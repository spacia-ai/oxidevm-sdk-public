import type { FileDescriptor } from "../js-process-types.js";
import type { Capability, CapabilityMap } from "./capabilities.js";
import type { Kit } from "./kit/index.js";
import type { CommandDecl, EndpointDecl, ModuleDecl, OptionDecl, ServiceDecl } from "./manifest-types.js";

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/** The value type a declared option accepts. */
export type OptionValue<D> =
  D extends { readonly type: "boolean" } ? boolean
  : D extends { readonly type: "integer" } ? number
  : D extends { readonly type: "string" } ? string
  : D extends { readonly type: "enum"; readonly values: readonly (infer V extends string)[] } ? V
  : D extends { readonly type: "enum-set"; readonly values: readonly (infer V extends string)[] } ? readonly V[]
  : never;

/** What the adapter sees: defaults applied, so every declared option is present. */
export type ResolvedOptions<O> = O extends Readonly<Record<string, OptionDecl>> ? { readonly [K in keyof O]: OptionValue<O[K]> } : Record<never, never>;

export interface HostArtifacts<N extends string = string> {
  /** Compiles a declared `.wasm` artifact, verified against its pin. */
  compile(name: N): Promise<WebAssembly.Module>;
  bytes(name: N): Promise<Uint8Array<ArrayBuffer>>;
  /** A same-origin URL for runtimes that fetch their own files. The runner checked the file against its pin when the module started; a fetch through this address is not checked again. */
  url(name: N): string;
}

/** The process's inherited standard descriptors. */
export interface Stdio {
  readonly stdin: FileDescriptor;
  readonly stdout: FileDescriptor;
  readonly stderr: FileDescriptor;
}

export interface BaseHost<O = unknown, N extends string = string> {
  readonly signal: AbortSignal;
  readonly options: ResolvedOptions<O>;
  readonly artifacts: HostArtifacts<N>;
  /** Tested helpers shared by every module (errno mapping, framing, gate, native children, atomic directories). */
  readonly kit: Kit;
  readonly stdio: Stdio;
  /** One structured line on the module's stderr. */
  log(line: string): void;
  /** Writes a message to stderr and returns `status` (1-119) for use as an exit status. */
  fail(status: number, message: string): number;
}

/** The injected host: always the base members, plus exactly the members of the declared capabilities. */
export type Host<C extends Capability = never, O = unknown, N extends string = string> =
  BaseHost<O, N> & ([C] extends [never] ? unknown : UnionToIntersection<CapabilityMap[C]>);

type OptionsOf<M extends ModuleDecl> = M extends { readonly options: infer O } ? O : undefined;
export type ArtifactName<M extends ModuleDecl> = M["artifacts"][number]["name"];
export type HostOf<M extends ModuleDecl> = Host<M["requires"]["host"][number], OptionsOf<M>, ArtifactName<M>>;

/** One accepted client of a service endpoint. */
export interface Connection {
  readonly fd: FileDescriptor;
  readonly signal: AbortSignal;
  /** Resolves with an empty array at end of stream. */
  read(maxBytes: number): Promise<Uint8Array>;
  /** Writes every byte or rejects. A client that has hung up rejects the write (EPIPE); it never ends the module. */
  write(bytes: Uint8Array): Promise<void>;
}

/** Whether each standard descriptor of a module command is a terminal. */
export interface Terminals {
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}

/**
 * How the module was started: by the application (`host`), or by a program in the VM that ran one of its `commands`
 * (engine ADR 0027), with the declared name, the canonical path of its stub and the caller's argv[0].
 */
export type Invocation<N extends string> =
  | { readonly kind: "host" }
  | { readonly kind: "command"; readonly name: N; readonly path: string; readonly argv0: string };

/** The names a manifest literal declares in `commands`; `never` when it declares none. */
export type CommandsOf<M> = M extends { readonly commands: readonly (infer N extends string)[] } ? N : never;

/** The process arguments and environment, and the same descriptors as `host.stdio`. */
interface BaseCommandIO extends Stdio {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/**
 * What `main` receives. A module that declares `commands` also learns how it was invoked and which descriptors are
 * terminals. A module without commands cannot read those fields, because a runner that predates commands never sets them.
 */
export type CommandIO<N extends string = never> = BaseCommandIO & ([N] extends [never] ? unknown : { readonly invocation: Invocation<N>; readonly terminals: Terminals });

export type Info = Readonly<Record<string, string | number | boolean>>;

/** What a command module returns from its factory; `N` is the names it declares in `commands`. */
export interface CommandHooks<N extends string = never> {
  /** Returns the exit status, 0-119. */
  main(io: CommandIO<N>): number | Promise<number>;
  close?(): void | Promise<void>;
}

/** What a service module returns from its factory: one handler per `expose` key. */
export interface ServiceHooks<E extends Readonly<Record<string, EndpointDecl>>> {
  /** Extra fields for the ready line. */
  info?(): Info | Promise<Info>;
  /** A handler runs for the lifetime of one connection. */
  readonly protocols: { readonly [K in keyof E]: (connection: Connection) => Promise<void> };
  close?(): void | Promise<void>;
}

export type Hooks<M extends ModuleDecl> =
  M extends ServiceDecl ? ServiceHooks<M["expose"]>
  : M extends CommandDecl ? CommandHooks<CommandsOf<M>>
  : never;

/**
 * The adapter is a factory: it runs once at start with the injected `host`, keeps whatever state it
 * needs in its closure, and returns the hooks the runner drives.
 */
export type AdapterFor<M extends ModuleDecl> = (host: HostOf<M>) => Hooks<M> | Promise<Hooks<M>>;

export interface Module<M extends ModuleDecl = ModuleDecl> {
  readonly manifest: M;
  readonly adapter: AdapterFor<M>;
}

/**
 * Types a module definition. The manifest literal is inferred first and fixes the adapter's shape:
 * its `host` holds only the declared capabilities and artifact names, and a service must return one
 * handler per `expose` key. At runtime this returns its argument.
 */
export function defineModule<const M extends ModuleDecl>(module: {
  readonly manifest: M;
  readonly adapter: AdapterFor<NoInfer<M>>;
}): Module<M> {
  return module;
}
