import { join } from "node:path";

const OVERRIDES = { "oxidevm_core.wasm": "OXIDEVM_CORE_WASM", "oxidevm_userspace.wasm": "OXIDEVM_USERSPACE_WASM" } as const;

/**
 * The engine module a core test executes. The SDK contains no engine binaries: a local engine
 * release supplies them through OXIDEVM_ENGINE_DIR (`pnpm engine:fetch` stages the pinned release
 * at .cache/engine/current), or one module through its older override variable.
 */
export function engineModulePath(name: keyof typeof OVERRIDES): string {
  const directory = process.env["OXIDEVM_ENGINE_DIR"];
  if (directory !== undefined && directory !== "") return join(directory, name);
  const override = process.env[OVERRIDES[name]];
  if (override !== undefined && override !== "") return override;
  throw new Error(`Core tests execute the real engine, which the SDK does not contain: set OXIDEVM_ENGINE_DIR to an engine release directory (the pinned one: OXIDEVM_ENGINE_DIR=$(node scripts/fetch-engine.ts --print-dir)) or ${OVERRIDES[name]} to ${name}`);
}
