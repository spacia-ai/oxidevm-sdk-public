import type {SystemOptions,UserspaceOptions,SnapshotKind} from "../contracts.js";
import type {TrustedImageKey} from "../image.js";
import type {RuntimeMode,SHA256} from "../values.js";
import type {SnapshotBrowser,SnapshotPhase,SnapshotTimeouts,SnapshotWorkload} from "../snapshot-authoring.js";
export type * from "../snapshot-authoring.js";
export interface SnapshotRecipeCommon {
  readonly name:string;readonly label?:string;readonly image:string;readonly imageTrust?:string;
  readonly files?:readonly {readonly from:string;readonly to:string}[];
  readonly workload:SnapshotWorkload;readonly verify:{readonly module:string};
  readonly browser?:SnapshotBrowser;readonly outDir?:string;readonly publicBaseUrl?:string;
  readonly timeouts?:SnapshotTimeouts;readonly maxDownloadBytes?:number;
}
export type SnapshotRecipe=SnapshotRecipeCommon & (
  | {readonly mode:"system";readonly vm?:Pick<SystemOptions,"memoryMiB"|"vcpus"|"network">}
  | {readonly mode:"userspace";readonly vm?:Pick<UserspaceOptions,"memoryMiB"|"limits"|"initialUser"|"rootPersistence"|"network">}
);
export interface SnapshotProgress {readonly buildId:string;readonly sequence:number;readonly phase:SnapshotPhase;readonly completedBytes?:number;readonly totalBytes?:number}
export interface BuildSnapshotOptions {
  readonly recipeDir:string;readonly signingKeyFile:string;readonly imageTrust?:TrustedImageKey;
  readonly outDir?:string;readonly publicBaseUrl?:string|URL;readonly browser?:SnapshotBrowser;
  readonly timeoutMs?:number;readonly engineDir?:string;readonly signal?:AbortSignal;readonly onProgress?:(progress:SnapshotProgress)=>void;
}
export interface TestSnapshotOptions {
  readonly trust:TrustedImageKey;readonly verifyModule?:string;readonly browser?:SnapshotBrowser;
  readonly timeoutMs?:number;readonly engineDir?:string;readonly signal?:AbortSignal;readonly onProgress?:(progress:SnapshotProgress)=>void;
}
export interface InspectSnapshotOptions {readonly trust?:TrustedImageKey;readonly signal?:AbortSignal}
export type SnapshotCheck="bundle-signature"|"image-integrity"|"snapshot-integrity"|"browser-features"|"shipped-resume"|"authoring-receipt"|"original-processes"|"custom-verification";
export type SnapshotCheckResult=
  | {readonly check:SnapshotCheck;readonly status:"passed"}
  | {readonly check:SnapshotCheck;readonly status:"failed";readonly message:string}
  | {readonly check:"authoring-receipt"|"original-processes";readonly status:"not-applicable";readonly reason:"receipt-absent"};
export interface SnapshotTestReport {
  readonly schemaVersion:1;readonly result:"passed"|"failed";readonly name:string;readonly mode:RuntimeMode;
  readonly bundleSHA256:SHA256|null;readonly snapshotManifestSHA256:SHA256;readonly imageManifestSHA256:SHA256;
  readonly snapshot:{readonly id:string;readonly kind:"shipped"};readonly sdkVersion:string;readonly engineReleaseId:string;
  readonly browser:{readonly name:SnapshotBrowser;readonly version:string};
  readonly verifier:{readonly source:"bundled"|"override";readonly sha256:SHA256};
  readonly checks:readonly SnapshotCheckResult[];
}
export interface SnapshotBuildResult {
  readonly name:string;readonly mode:RuntimeMode;readonly bundlePath:string;readonly referencePath:string;
  readonly bundleSHA256:SHA256;readonly snapshotManifestSHA256:SHA256;readonly imageManifestSHA256:SHA256;
  readonly snapshot:{readonly id:string;readonly kind:"shipped"};readonly sdkVersion:string;readonly engineReleaseId:string;
  readonly verification:{readonly status:"passed";readonly browser:SnapshotBrowser;readonly browserVersion:string;readonly resume:"shipped"};
  readonly distribution:{readonly status:"development-only"};
}
export interface SnapshotCapturedSummary {
  readonly id:string;readonly mode:RuntimeMode;readonly kind:SnapshotKind;readonly capturedAtUnixMs:number;
  readonly memoryMiB:number;readonly vcpus:number;readonly stateFormatVersion:number;
}
export type SnapshotInspectResult=
  | {readonly kind:"backup";readonly integrity:"verified";readonly snapshot:SnapshotCapturedSummary;readonly fileBytes:number;readonly authentication:{readonly kind:"unsigned"}}
  | {readonly kind:"bundle";readonly integrity:"verified";readonly snapshot:SnapshotCapturedSummary;readonly name:string;
    readonly bundleSHA256:SHA256;readonly snapshotManifestSHA256:SHA256;readonly imageManifestSHA256:SHA256;
    readonly sdkVersion:string;readonly engineReleaseId:string;readonly verifierSHA256:SHA256;
    readonly artifactCount:number;readonly artifactBytes:number;readonly distribution:{readonly status:"development-only"};
    readonly authentication:{readonly kind:"verified";readonly keyId:string}|{readonly kind:"unverified"}};
