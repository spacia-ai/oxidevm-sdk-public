export { BROWSER_FEATURES, CAPABILITY_MIN_API, isBrowserFeature, isCapability } from "./wasm/capabilities.js";
export type { BrowserFeature, Capability, CapabilityMap, ClientSockets } from "./wasm/capabilities.js";
export { defineModule } from "./wasm/define.js";
export type {
  AdapterFor, ArtifactName, BaseHost, CommandHooks, CommandIO, Connection, Hooks, Host, HostArtifacts, HostOf, Info, Module, OptionValue,
  ResolvedOptions, ServiceHooks, Stdio,
} from "./wasm/define.js";
export { kit } from "./wasm/kit/index.js";
export type { AtomicDirectory, Gate, Kit, NativeRunHost, NativeRunRequest, NativeRunResult } from "./wasm/kit/index.js";
export { MODULE_EXIT, MODULE_EXIT_REASONS } from "./wasm/exit-codes.js";
export type { ModuleExitReason } from "./wasm/exit-codes.js";
export { moduleHandle } from "./wasm/handle.js";
export type { ErasedSpawnOptions, LaunchPins, ModuleHandle, ModuleProcess, OptionArgs, Pin, PinnedFile, SpawnArgs, SpawnOptions } from "./wasm/handle.js";
export { classifyLicense } from "./wasm/license.js";
export type { LicenseClassification } from "./wasm/license.js";
export { decodeDeclaration, decodeModuleManifest, decodeResolvedManifest, encodeModuleManifest, isServiceDecl } from "./wasm/manifest.js";
export type {
  AbiKind, ArtifactDecl, CommandDecl, EndpointDecl, GuestFileDecl, LicenseDecl, LimitsDecl, ModuleDecl, MountDecl, OptionDecl, ResolvedArtifact,
  ResolvedManifest, ServiceDecl, TcpEndpoint, UnixEndpoint, UpstreamDecl,
} from "./wasm/manifest-types.js";
export { spawnModule, stopModule } from "./wasm/spawn.js";
export type { ModuleVM } from "./wasm/spawn.js";
export { inspectWasm } from "./wasm/inspect.js";
export type { WasmReport } from "./wasm/inspect-types.js";
