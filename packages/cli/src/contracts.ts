import type { RuntimeMode, SHA256, VMErrorCode } from "@oxidevm/sdk";
import type { DoctorReport, ImageDistribution, ImageInspection, ImagePackReport, ImageTestReport, ProjectLockChange,SnapshotBuildResult,SnapshotTestReport,SnapshotInspectResult, WasmAddResult, WasmBuildResult, WasmDoctorReport, WasmInspectResult, WasmStageResult, WasmTestReport } from "@oxidevm/sdk/image-builder";

/** The deployment doctor's report is the SDK's (`decodeDoctorReport` owns its decoding). */
export type { DoctorCheck, DoctorHosting, DoctorReport } from "@oxidevm/sdk/image-builder";

export interface WasmInitResult {
  readonly directory: string;
  readonly id: string;
  readonly kind: "command" | "service";
  readonly abi: string;
  /** The network reach module.ts declares (engine ADR 0029): `wasm init --network`. */
  readonly network: "none" | "vm" | "internet";
  /** Every file created, relative to the directory and sorted. */
  readonly files: readonly string[];
  /**
   * A command module's `commands` as module.ts declares them: its id, or none when the id starts with the reserved prefix
   * `oxidevm`. A service has no such key.
   */
  readonly commands?: readonly string[];
}

/** A finished build plus the commands that publish it. Nothing here has been run. */
export interface WasmReleaseResult {
  readonly build: WasmBuildResult;
  /** The git tag the release must carry, `v` plus the version; null when the build failed. */
  readonly tag: string | null;
  readonly steps: readonly string[];
}

export interface CliResultMap {
  readonly "wasm add": WasmAddResult;
  readonly "wasm stage": WasmStageResult;
  readonly "wasm doctor": WasmDoctorReport;
  readonly "wasm inspect": WasmInspectResult;
  readonly "wasm build": WasmBuildResult;
  readonly "wasm release": WasmReleaseResult;
  readonly "wasm init": WasmInitResult;
  readonly "wasm test": WasmTestReport;
  readonly "snapshot init":{readonly directory:string;readonly recipePath:string;readonly mode:RuntimeMode;readonly name:string;readonly files:readonly string[]};
  readonly "snapshot build":SnapshotBuildResult;
  readonly "snapshot pack":SnapshotBuildResult;
  readonly "snapshot test":SnapshotTestReport;
  readonly "snapshot inspect":SnapshotInspectResult;
  readonly init: { readonly directory: string; readonly mode: RuntimeMode; readonly assets: "installed" | "skipped" };
  readonly "assets install": { readonly publicDir: string; readonly files: number; readonly referencePath: string | null; readonly lock: ProjectLockChange };
  readonly doctor: DoctorReport;
  readonly "image init": { readonly directory: string; readonly recipePath: string; readonly mode: RuntimeMode };
  readonly "image keygen": { readonly privateKeyPath: string; readonly publicKeyPath: string; readonly keyId: string };
  readonly "image build": {
    readonly mode: RuntimeMode;
    readonly manifestSHA256: SHA256;
    readonly bundleDir: string;
    readonly referencePath: string;
    readonly lockPath: string;
    readonly distribution: ImageDistribution;
  };
  readonly "image test": ImageTestReport;
  readonly "image inspect": ImageInspection;
  readonly "image pack": ImagePackReport;
}

export type CliCommand = keyof CliResultMap;
export type CliReport = {
  readonly [K in CliCommand]: {
    readonly schemaVersion: 3;
    readonly kind: "result";
    readonly command: K;
    readonly result: CliResultMap[K];
  };
}[CliCommand] | {
  readonly schemaVersion: 3;
  readonly kind: "error";
  readonly command: CliCommand | null;
  readonly error: {
    readonly code: VMErrorCode;
    readonly message: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  };
};
