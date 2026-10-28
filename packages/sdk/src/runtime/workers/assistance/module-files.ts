/** Canonical Linux resolution and authoritative bytes, supplied by the task's
 * file owner. Runtime module instances never own filesystem state. */
export type ModuleFormat = "commonjs" | "module" | "json";
export interface ModulePathInfo { readonly path: string; readonly mode: number }
export interface LocalModuleFiles {
  readonly dependencies?: ModuleDependencyIdentity;
  readonly loadNative?: (path: string) => unknown;
  resolve(specifier: string, parent: string, kind: "require" | "import"): string;
  read(path: string): { readonly source: string; readonly format: ModuleFormat };
}
import type { AssistedDependencyIdentity } from "../../protocol/assistance-broker.ts";
import type { JSProcessIdentity } from "../../js-process/codec.js";
import type { NativeProcessProfile } from "../../userspace-command-abi.js";
export type ModuleDependencyIdentity = AssistedDependencyIdentity | JSProcessIdentity | { readonly generation: bigint; readonly profile: NativeProcessProfile["identity"]; readonly roots: NativeProcessProfile["roots"]; readonly runtime: "node" | "bun"; readonly moduleSearchPaths: readonly string[] };
