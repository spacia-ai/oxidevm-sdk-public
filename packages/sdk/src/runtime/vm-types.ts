import type { CommandInterceptorRecord } from "../command-interceptors.js";
import type {ShippedSnapshotRef} from "../shipped-snapshot.js";
import type {PreparedImageIdentity} from "./protocol/storage.js";
import type { UserspaceWorkspaceStart } from "./protocol/workspace-start.js";
import type { PreviewKeeperHost } from "./preview-keeper.js";
import type { VMNetwork } from "./network-types.js";
import type { CoreProbeResult, PreparedManagedImage, PreparedUserspaceRootfs, SystemProbeResult, SystemSliceResult, SystemTraceSnapshot, SnapshotRef, RuntimeVMCapabilities } from "./protocol.js";
import type { BuildScriptIdentity } from "./protocol/build-script-approval.js";
import type { InstallationProfile } from "./protocol/assistance-installation-profile.js";
import type { ManagedResume, ManagedStart, SnapshotInfo, StartProgress, RuntimeVMSnapshots } from "./snapshot-types.js";
import type { SystemExecution } from "./system-execution.js";
import type { Workspace } from "./workspace.js";
import type { WorkspaceMovedAway } from "./workspace-handoff.js";
import type { ImagePreparation } from "../values.js";
import type { AccelerationNotice } from "./js-process/late-failure.js";

export type RuntimeMode = "system" | "userspace";
export type NetworkMode = "local" | "relay";

export type ProcessExecution =
  | { readonly kind: "guest" }
  | { readonly kind: "assisted-node"; readonly profile: "node24-next16-v1" };

export interface AssistanceOptions {
  readonly executionOrigin: string;
  readonly manifestUrl: string;
  /** Decisions are retained outside project files for an explicit installation retry. */
  readonly approveBuildScript?: (request: BuildScriptApprovalRequest) => Promise<"allow" | "deny">;
}

export interface BuildScriptApprovalRequest extends BuildScriptIdentity {
  readonly signal: AbortSignal;
}

export interface DependencyPreparationOptions {
  readonly cwd?: string;
  readonly frozenLockfile?: boolean;
  readonly signal?: AbortSignal;
}

/** How previews are hosted: one origin per session below `previewOrigin` (the default), or
 * `previewOrigin` itself shared by every session, for a one-person setup whose Playground runs
 * on the same host, such as a phone over Tailscale (ADR 0015). Shared sessions share that
 * origin's cookies and storage with each other and with the page's host. */
export type PreviewIsolation = "per-session" | "shared";

/** A TCP port an app in the VM listens on. */
export interface ListeningPort {
  /** 1 to 65535. */
  readonly port: number;
  /** The address as bound: "0.0.0.0", "::", "127.0.0.1", "::1", and so on. */
  readonly address: string;
  /** The command typed in the terminal that started it, at most 256 characters; null when unknown. */
  readonly program: string | null;
  /** A preview can reach it in this mode. */
  readonly previewable: boolean;
}

export interface CommonOptions {
  readonly ephemeral?: boolean;
  workspaceId: string;
  memoryMiB: number;
  network: NetworkMode;
  relayUrl?: string;
  /** Restricts this application to personal relay connections. */
  relayPolicy?: "personal-only";
  previewOrigin?: string;
  /** Requires `previewOrigin`; "per-session" when absent. */
  previewIsolation?: PreviewIsolation;
  /**
   * Where preview keepers live. Absent, this document embeds them; the runtime frame (ADR 0021)
   * passes the page that embeds it, so keepers share the partition of the page that shows the
   * preview.
   */
  previewKeeperHost?: PreviewKeeperHost;
}

export interface UserspaceLimitsOptions {
  /**
   * Bounds live Userspace processes, forked descendants included (1–64). Omitted, the engine
   * keeps its own cap of 4,096; the public `createVM` always passes a bound (32 by default).
   */
  readonly maxProcesses?: number;
}

export type RuntimeVMOptions =
  | (CommonOptions & {
      mode: "system";
      vcpus: 1 | 2 | 3 | 4;
      coreWasmUrl?: string;
      sharedCoreWasmUrl?: string;
      /** The network link's router module; "/oxidevm_netstack.wasm" when absent. */
      netstackWasmUrl?: string;
      assistance?: AssistanceOptions;
    })
  | (CommonOptions & {
      mode: "userspace";
      readonly interceptors?: readonly CommandInterceptorRecord[];
      readonly nativeExecutionPort?: MessagePort;
      userspaceWasmUrl?: string;
      userspaceSharedWasmUrl?: string;
      userspaceWasmModule?: WebAssembly.Module;
      /** Initial guest credentials; ordinary user (uid/gid 1000) when absent. */
      initialUser?: "user" | "root";
      /** Writable system files are ephemeral when absent. */
      rootPersistence?: "ephemeral" | "persistent";
      limits?: UserspaceLimitsOptions;
    });

export interface SpawnSpec {
  execution?: ProcessExecution;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  terminal?: { readonly columns: number; readonly rows: number };
  signal?: AbortSignal;
}

export type {ProcessHandle} from "./process-types.js";
import type {ProcessHandle} from "./process-types.js";

export interface DependencyInstallHandle extends ProcessHandle {
  /** SHA-256 identity of the durably committed dependency manifest. */
  readonly generation: Promise<string>;
}

export interface PreviewHandle {
  readonly url: URL;
  close(): Promise<void>;
}

export interface ManagedImageInfo {
  readonly identity?: PreparedImageIdentity;
  readonly id: string;
  readonly version: string;
  readonly runtimes: PreparedManagedImage["runtimes"] | PreparedUserspaceRootfs["runtimes"];
  /** How a full-system VM started: resumed from a restore point, or booted and why. */
  readonly start?: ManagedStart;
  /** How a Userspace VM's saved /workspace met this image, when the image has a workspace base. */
  readonly workspace?: UserspaceWorkspaceStart;
  /**
   * The image the page asked for when the workspace's disk runs another (the one `id` and
   * `version` name): the workspace keeps running it until a boot with `resume: "update-image"`.
   */
  readonly update?: { readonly id: string; readonly version: string };
}

export interface ManagedImageBootOptions {
  readonly imagePreparation?: ImagePreparation;
  /** Internal verified retained-image startup: refuse fetching another manifest. */
  readonly cachedOnly?: boolean;
  readonly manifestSHA256?: string;
  readonly signal?: AbortSignal;
  readonly trustedKeyId?: string;
  readonly trustedPublicKey?: Uint8Array;
  /**
   * Where a managed VM starts (default `"none"`, a cold boot from the live files). Unless it
   * is `"fresh-image"` or `"update-image"`, a workspace whose disk runs another image keeps
   * running that one and names this one as `update` in either runtime mode.
   */
  readonly resume?: ManagedResume;
  /** Called with each step of a resume; a cold boot reports none. */
  readonly onProgress?: (progress: StartProgress) => void;
  /**
   * The signed shipped restore point to open on first visit, when this workspace has no save.
   * The selected system or Userspace manifest must list it under the caller's trusted key.
   */
  readonly shipped?: string | ShippedSnapshotRef<"system" | "userspace">;
}

export interface SystemBootSpec {
  readonly kernel: Uint8Array;
  readonly initrd?: Uint8Array;
  readonly disk?: Uint8Array;
  readonly commandLine: string;
}

export type { InstallationProfile } from "./protocol/assistance-installation-profile.js";

export interface RuntimeVMDiagnostics {
  runCoreProbe(
    program: Uint8Array,
    options?: { maximumSteps?: number; signal?: AbortSignal },
  ): Promise<CoreProbeResult>;
  runSystemProbe(
    boot: SystemBootSpec,
    options?: { maximumSteps?: number; signal?: AbortSignal },
  ): Promise<SystemProbeResult>;
  bootSystem(
    boot: SystemBootSpec,
    options?: { signal?: AbortSignal; console?: "serial" | "virtio" },
  ): Promise<void>;
  runSystemSlice(options?: {
    maximumSteps?: number;
    signal?: AbortSignal;
  }): Promise<SystemSliceResult>;
  startSystem(options?: { signal?: AbortSignal }): Promise<SystemExecution>;
  writeSystemConsole(
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Sets the System console's dimensions. Linux receives resize events through virtio. */
  resizeSystemConsole(
    size: { readonly columns: number; readonly rows: number },
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  configureSystemTrace(options?: {
    capacity?: number;
    interpreterOnly?: boolean;
    interpretedSemantics?: readonly number[];
    interpretedRipRanges?: readonly {
      readonly start: bigint;
      readonly end: bigint;
    }[];
    checkpointPolicy?: "faults-and-stderr" | "faults-only";
    signal?: AbortSignal;
  }): Promise<void>;
  readSystemTrace(options?: {
    signal?: AbortSignal;
  }): Promise<SystemTraceSnapshot>;
  /** Bounded attribution for the active or last dependency preparation; undefined before any preparation. */
  readInstallationProfile(options?: {
    signal?: AbortSignal;
  }): Promise<InstallationProfile | undefined>;
}

export interface RuntimeVM {
  readonly imageIdentity?:PreparedImageIdentity|undefined;
  storagePersistence?(): Promise<"opfs" | "indexeddb">;
  checkForUpdate?(options?:{readonly signal?:AbortSignal}):Promise<{readonly id:string;readonly version:string}|null>;
  prepareImage(options?:{readonly signal?:AbortSignal}):Promise<void>;
  readonly mode: RuntimeMode;
  readonly capabilities: RuntimeVMCapabilities;
  readonly workspace: Workspace;
  readonly diagnostics: RuntimeVMDiagnostics;
  readonly network: VMNetwork;
  bootManagedImage(
    manifestUrl: string | URL,
    options?: ManagedImageBootOptions,
  ): Promise<ManagedImageInfo>;
  spawn(spec: SpawnSpec): Promise<ProcessHandle>;
  /** Internal migration seam: the public facade's cwd names a native guest directory. */
  spawnGuest?(spec: SpawnSpec): Promise<ProcessHandle>;
  readJSProcessTrace?(capacity?: number): Promise<Uint8Array>;
  /** ADR 0026: each late fast-path failure until `options.signal` aborts or the VM ends. */
  watchAccelerationNotices?(listener: (notice: AccelerationNotice) => void, options: { readonly signal: AbortSignal }): Promise<void>;
  spawnJS?(spec: Omit<SpawnSpec, "command"> & { readonly worker: string }): Promise<ProcessHandle>;
  /** Requires an admitted system build and an implemented guest preparation capability. */
  prepareDependencies(options?: DependencyPreparationOptions): Promise<DependencyInstallHandle>;
  exposePort(port: number, options?: { readonly signal?: AbortSignal }): Promise<PreviewHandle>;
  /** The TCP ports apps in the VM listen on, lowest first (at most 256). In System mode the guest
   * agent reports them; FEATURE_NOT_AVAILABLE with `reason` "image-update-required" when the
   * image's agent cannot (no capability 64), or "agent-not-ready" before the agent greets. */
  listeningPorts(options?: { readonly signal?: AbortSignal }): Promise<readonly ListeningPort[]>;
  /** Calls `onChange` with the first list and then whenever it changes, until `signal` aborts;
   * resolves then, and rejects with a VMError when reading fails (PROTOCOL_ERROR once the VM
   * is disposed). */
  watchListeningPorts(onChange: (ports: readonly ListeningPort[]) => void, options: { readonly signal: AbortSignal }): Promise<void>;
  /** Restore points of a full-system VM; a Userspace VM refuses every call. */
  readonly snapshots: RuntimeVMSnapshots;
  /** Saves the VM: a named restore point with `label`, an automatic save without. */
  snapshot(label?: string): Promise<SnapshotRef>;
  /** Restores `snapshot` without saving the current state first (`snapshots.restore` does). */
  restore(snapshot: SnapshotRef): Promise<void>;
  /**
   * Lets another tab take this VM's workspace (`requestWorkspaceHandoff`) until `signal` aborts
   * or the VM is disposed. When a tab asks, a running full-system VM is saved first; then the VM
   * is disposed and `onMovedAway` says whether it was saved.
   */
  allowWorkspaceHandoff(onMovedAway: (moved: WorkspaceMovedAway) => void, options: { readonly signal: AbortSignal }): void;
  /**
   * Saves a running managed full-system VM as a safety point named `label`, then disposes it, as
   * a switch to the other mode does. The guest's files go to the workspace store first, so the
   * other mode opens them and resuming the point carries in what that mode changed. Resolves with
   * the point once it is saved, while disposal goes on (`dispose()` returns it). A refused save
   * leaves the VM running, with assisted processes ended and automatic saves off. A Userspace VM
   * refuses: its running programs cannot be saved.
   */
  suspend(options: { readonly label: string; readonly signal?: AbortSignal }): Promise<SnapshotInfo>;
  dispose(): Promise<void>;
}
