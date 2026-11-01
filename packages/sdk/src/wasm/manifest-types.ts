import type { BrowserFeature, Capability } from "./capabilities.js";

export type AbiKind = "wasi" | "component" | "emscripten" | "bindgen" | "raw";

/**
 * An artifact in an author's manifest names a repository file (`from`). A resolved `module.json`
 * names the same artifact by `name`, `sha256` and `bytes` only.
 */
export interface ArtifactDecl {
  readonly name: string;
  readonly from?: string;
  readonly sha256?: string;
  readonly bytes?: number;
}

export interface MountDecl {
  readonly guest: string;
  readonly access: "ro" | "rw";
  readonly durability?: "fsync";
}

/** A declared artifact materialized as a file in the guest before the module starts. */
export interface GuestFileDecl {
  readonly artifact: string;
  readonly to: string;
  readonly mode?: number;
}

export interface LimitsDecl {
  readonly clients?: number;
  readonly startupMs?: number;
}

export interface LicenseDecl {
  readonly spdx: string;
  readonly notices?: readonly string[];
  readonly source?: string;
}

export interface UpstreamDecl {
  readonly name: string;
  readonly version: string;
  readonly source: string;
}

export interface UnixEndpoint {
  readonly kind: "unix";
  readonly path: string;
  readonly protocol: string;
}
export interface TcpEndpoint {
  readonly kind: "tcp";
  readonly port: number;
  readonly protocol: string;
}
export type EndpointDecl = UnixEndpoint | TcpEndpoint;

/** Options a consumer may pass to `spawnModule`; the subset is deliberately small and closed. */
export type OptionDecl =
  | { readonly type: "boolean"; readonly default?: boolean }
  | { readonly type: "integer"; readonly min: number; readonly max: number; readonly default?: number }
  | { readonly type: "string"; readonly maxLength: number; readonly default?: string }
  | { readonly type: "enum"; readonly values: readonly string[]; readonly default?: string }
  | { readonly type: "enum-set"; readonly values: readonly string[]; readonly default?: readonly string[] };

export interface CommonDecl {
  readonly id: string;
  readonly version: string;
  readonly abi: AbiKind;
  readonly artifacts: readonly ArtifactDecl[];
  readonly requires: {
    readonly host: readonly Capability[];
    readonly browser?: readonly BrowserFeature[];
    readonly guest?: { readonly executables?: readonly string[] };
  };
  readonly mounts?: readonly MountDecl[];
  readonly limits?: LimitsDecl;
  readonly state?: { readonly durable: readonly string[] };
  readonly guestFiles?: readonly GuestFileDecl[];
  readonly options?: Readonly<Record<string, OptionDecl>>;
  readonly license: LicenseDecl;
  readonly upstream?: readonly UpstreamDecl[];
}

/** Runs `main` once, or for as long as the program keeps its stdio open. */
export interface CommandDecl extends CommonDecl {
  readonly process: { readonly kind: "command" };
}

/** Owns listeners declared by `expose`; its adapter implements one handler per endpoint key. */
export interface ServiceDecl extends CommonDecl {
  readonly process: { readonly kind: "service"; readonly exclusive?: "workspace" };
  readonly expose: Readonly<Record<string, EndpointDecl>>;
}

export type ModuleDecl = CommandDecl | ServiceDecl;

export interface ResolvedArtifact extends ArtifactDecl {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** What the build adds to a declaration: the adapter's pin and a pin for every artifact. */
export interface ResolvedPins {
  readonly schemaVersion: 1;
  readonly adapter: { readonly api: 1; readonly sha256: string; readonly bytes: number };
  readonly artifacts: readonly ResolvedArtifact[];
}

/**
 * The contents of a release's `module.json`: the declaration plus the pins the build computed. It is a
 * union of two object types, not `ModuleDecl & ResolvedPins`, because intersecting the two `artifacts`
 * array types would leave every element's pin optional.
 */
export type ResolvedManifest = (Omit<CommandDecl, "artifacts"> & ResolvedPins) | (Omit<ServiceDecl, "artifacts"> & ResolvedPins);
