import type { RuntimeMode, SHA256, VMErrorCode } from "@oxidevm/sdk";
import type { ImageDistribution, ImageInspection, ImagePackReport, ImageTestReport,SnapshotBuildResult,SnapshotTestReport,SnapshotInspectResult } from "@oxidevm/sdk/image-builder";

export type DoctorCheck =
  | "secure-context" | "cross-origin-isolation" | "wasm-features" | "worker-load"
  | "asset-integrity" | "wasm-mime" | "content-security-policy" | "storage"
  | "preview-origin";

export interface DoctorReport {
  readonly result: "passed" | "failed";
  readonly url: string;
  readonly checks: readonly (
    | { readonly check: DoctorCheck; readonly status: "passed" }
    | { readonly check: DoctorCheck; readonly status: "failed"; readonly message: string }
    | { readonly check: "preview-origin"; readonly status: "not-configured" }
  )[];
}

export interface CliResultMap {
  readonly "snapshot init":{readonly directory:string;readonly recipePath:string;readonly mode:RuntimeMode;readonly name:string;readonly files:readonly string[]};
  readonly "snapshot build":SnapshotBuildResult;
  readonly "snapshot pack":SnapshotBuildResult;
  readonly "snapshot test":SnapshotTestReport;
  readonly "snapshot inspect":SnapshotInspectResult;
  readonly init: { readonly directory: string; readonly mode: RuntimeMode; readonly assets: "installed" | "skipped" };
  readonly "assets install": { readonly publicDir: string; readonly files: number; readonly referencePath: string | null };
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
    readonly schemaVersion: 2;
    readonly kind: "result";
    readonly command: K;
    readonly result: CliResultMap[K];
  };
}[CliCommand] | {
  readonly schemaVersion: 2;
  readonly kind: "error";
  readonly command: CliCommand | null;
  readonly error: {
    readonly code: VMErrorCode;
    readonly message: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  };
};
