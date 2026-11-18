/** Canonical Linux resolution and authoritative bytes, supplied by the task's
 * file owner. Runtime module instances never own filesystem state. */
export type ModuleFormat = "commonjs" | "module" | "json";
/** A module's bytes and format. `typelessPackage` names the `package.json` without `"type"` under which Node's
 * syntax detection made the file an ES module, outside `node_modules`: importing it prints Node's warning. */
export interface ModuleSource { readonly source: string; readonly format: ModuleFormat; readonly typelessPackage?: string }
export interface ModulePathInfo { readonly path: string; readonly mode: number }
export interface LocalModuleFiles {
  readonly dependencies?: ModuleDependencyIdentity;
  readonly loadNative?: (path: string) => unknown;
  resolve(specifier: string, parent: string, kind: "require" | "import"): string;
  /** `kind` is how the module is loaded when the caller knows it; Node admits fewer extensions to `import`. */
  read(path: string, kind?: "require" | "import"): ModuleSource;
}
import type { AssistedDependencyIdentity } from "../../protocol/assistance-broker.ts";
import type { JSProcessIdentity } from "../../js-process/codec.js";
import type { NativeProcessProfile } from "../../userspace-command-abi.js";
export type ModuleDependencyIdentity = AssistedDependencyIdentity | JSProcessIdentity | { readonly generation: bigint; readonly profile: NativeProcessProfile["identity"]; readonly roots: NativeProcessProfile["roots"]; readonly runtime: "node" | "bun"; readonly moduleSearchPaths: readonly string[] };
