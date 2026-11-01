import type { AbiKind } from "./manifest-types.js";

/** What a WebAssembly binary says about itself; it is compiled to read its imports and exports, never instantiated. */
export interface WasmReport {
  readonly kind: "module" | "component";
  readonly bytes: number;
  /** Imported namespaces with how many names each imports. */
  readonly imports: readonly { readonly module: string; readonly names: number }[];
  readonly exports: readonly string[];
  readonly customSections: readonly string[];
  readonly memories: readonly { readonly minPages: number; readonly maxPages: number | null; readonly shared: boolean; readonly memory64: boolean }[];
  readonly abi: AbiKind;
  /** Why the ABI was chosen, in order of strength. */
  readonly evidence: readonly string[];
  /** The `target_features` section is absent from most toolchain output, so features are not inferred from it. */
  readonly targetFeatures: boolean;
}
