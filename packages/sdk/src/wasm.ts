export { BROWSER_FEATURES, CAPABILITY_MIN_API, COMMANDS_MIN_API, isBrowserFeature, isCapability, manifestMinApi } from "./wasm/capabilities.js";
export type { BlockableSignal, BrowserFeature, Capability, CapabilityMap, ClientSockets, NetConnection, NetConnectOptions, NetHost, NetReadOptions, NetSyncConnection, NetTlsOptions, NetTlsSession, ProcessSignals, RealtimeArrival, SignalTrap, TrapArrival, TrappableSignal, TrappedSignal, TrapSignal } from "./wasm/capabilities.js";
export type { RealtimeSignalName, RealtimeSignalNumber, SignalName } from "./runtime/process-signals.js";
export type { ModuleReach } from "./wasm/reach.js";
export { defineModule } from "./wasm/define.js";
export type {
  AdapterFor, ArtifactName, BaseHost, CommandHooks, CommandIO, Connection, Hooks, Host, HostArtifacts, HostOf, Info, Invocation, Module, OptionValue,
  ResolvedOptions, ServiceHooks, Stdio, Terminals,
} from "./wasm/define.js";
export { kit } from "./wasm/kit/index.js";
export type { AtomicDirectory, BlockingIo, EmscriptenNetwork, Gate, Kit, NativeRunHost, NativeRunRequest, NativeRunResult } from "./wasm/kit/index.js";
export { NetError } from "./wasm/net/errors.js";
export type { NetErrorCode, NetErrorReason } from "./wasm/net/errors.js";
export { TlsError } from "./wasm/net/tls.js";
export type { TlsFailure } from "./wasm/net/tls.js";
export { MODULE_EXIT, MODULE_EXIT_REASONS } from "./wasm/exit-codes.js";
export type { ModuleExitReason } from "./wasm/exit-codes.js";
export { moduleHandle } from "./wasm/handle.js";
export type { CommandName, ErasedSpawnOptions, LaunchPins, ModuleHandle, ModuleProcess, OptionArgs, Pin, PinnedFile, SpawnArgs, SpawnOptions } from "./wasm/handle.js";
export { classifyLicense } from "./wasm/license.js";
export type { LicenseClassification } from "./wasm/license.js";
export { decodeDeclaration, decodeModuleManifest, decodeResolvedManifest, encodeModuleManifest, isServiceDecl } from "./wasm/manifest.js";
export type {
  AbiKind, ArtifactDecl, CommandDecl, EndpointDecl, GuestFileDecl, LicenseDecl, LimitsDecl, ModuleDecl, MountDecl, NetworkDecl, OptionDecl, ResolvedArtifact,
  ResolvedManifest, ServiceDecl, TcpEndpoint, UnixEndpoint, UpstreamDecl,
} from "./wasm/manifest-types.js";
export { spawnModule, stopModule } from "./wasm/spawn.js";
export type { ModuleVM } from "./wasm/spawn.js";
export { enableModuleCommands } from "./wasm/commands.js";
export type { EnableCommandsArgs, EnableCommandsOptions, ErasedEnableCommandsOptions, ModuleCommands, ModuleCommandsStatus, SkippedModuleCommand } from "./wasm/commands.js";
export { inspectWasm } from "./wasm/inspect.js";
export type { WasmReport } from "./wasm/inspect-types.js";
