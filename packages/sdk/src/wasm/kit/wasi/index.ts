/**
 * Running wasm32-wasip1 programs as the module's Linux process (`host.kit.wasi`): WASI Preview1 over the VM's live
 * descriptors and files, the VM's clocks and entropy, and the `oxidevm_bridge_v1` imports (process identity, native
 * children, VM sockets) that the `oxidevm-bridge` Rust crate calls.
 */
export { admit, run, BRIDGE_FUNCTIONS, type WasiIO, type WasiRunOptions } from "./run.js";
export { compile, readProgram, ProgramTooLarge } from "./program.js";
export { admitShape } from "./shape.js";
export { AdmissionError } from "./admission.js";
export { LIMITS } from "./limits.js";
export { ROOT_PREOPEN, type Preopen } from "./preview1.js";
export { PREVIEW1_IMPORTS, BRIDGE_NAMESPACE, PREVIEW1_NAMESPACE } from "./imports.js";
export type { WasiHost, WasiRunHost } from "./host.js";
