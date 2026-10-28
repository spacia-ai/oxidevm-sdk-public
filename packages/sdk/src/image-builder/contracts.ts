import type { ImageLocation, ImageRef } from "../image.js";
import type { RuntimeMode, SHA256 } from "../values.js";


export interface FileArtifactInput {
  readonly path: string;
  readonly sha256: string;
}

export type RootfsSource =
  | {
      readonly kind: "dockerfile";
      readonly context: string;
      readonly file: string;
      readonly target?: string;
      readonly buildArgs?: Readonly<Record<string, string>>;
    }
  | { readonly kind: "oci"; readonly reference: string }
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "archive"; readonly artifact: FileArtifactInput };

export interface BootFilesSource {
  readonly kind: "boot-files";
  readonly kernel: FileArtifactInput;
  readonly initrd?: FileArtifactInput;
  readonly disk: FileArtifactInput;
  readonly commandLine: string;
}

export type KernelSource =
  | { readonly kind: "managed-default" }
  | { readonly kind: "file"; readonly artifact: FileArtifactInput };

export interface ImageSmokeTest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly expectedExitCode: 0;
  readonly stdoutIncludes?: string;
}

export interface EvidenceInputs {
  readonly sbom:
    | { readonly kind: "buildkit" }
    | { readonly kind: "file"; readonly path: string };
  readonly noticesFile: string;
  readonly correspondingSourcesFile: string;
  readonly licensePolicyFile: string;
}

export interface CommonImageRecipe {
  readonly id: string;
  readonly version: string;
  readonly cpuProfile?: "x86-64-v2" | "x86-64-v3";
  readonly sourceDateEpoch?: number;
  readonly smokeTest: ImageSmokeTest;
  readonly evidence?: EvidenceInputs;
}

export interface UserspaceImageRecipe extends CommonImageRecipe {
  readonly mode: "userspace";
  readonly source: RootfsSource;
  readonly resources?: { readonly memoryMiB?: number; readonly maxProcesses?: number };
  /** Owner recorded for `/workspace` and every entry below it, whatever the source recorded.
   * Absent, it is the runtime's default user, uid/gid 1000. IDs range from 0 to 4294967294. */
  readonly workspace?: { readonly ownership: { readonly uid: number; readonly gid: number } };
  readonly boot?: never;
  readonly disk?: never;
}

export type SystemImageRecipe = CommonImageRecipe & {
  readonly mode: "system";
  readonly resources?: { readonly memoryMiB?: number; readonly vcpus?: 1 | 2 | 3 | 4 };
  /** A System disk keeps the owners its source recorded. */
  readonly workspace?: never;
} & (
  | {
      readonly source: RootfsSource;
      readonly boot: {
        readonly kernel: KernelSource;
        readonly initrd?: FileArtifactInput;
        readonly commandLine?: string;
      };
      readonly disk?: { readonly sizeMiB?: number };
    }
  | { readonly source: BootFilesSource; readonly boot?: never; readonly disk?: never }
);

export type ImageRecipe = SystemImageRecipe | UserspaceImageRecipe;

export type EvidenceRequirement =
  | "sbom" | "notices" | "corresponding-sources" | "license-review"
  | "reproducibility" | "browser-tests";

export type ImageDistribution =
  | { readonly kind: "development"; readonly missing: readonly EvidenceRequirement[] }
  | { readonly kind: "candidate"; readonly browserTestsRequired: true };

export interface ImageBuildResult<M extends RuntimeMode> {
  readonly mode: M;
  readonly image: ImageRef<M>;
  readonly bundleDir: string;
  readonly manifestPath: string;
  readonly referencePath: string;
  readonly lockPath: string;
  readonly distribution: ImageDistribution;
}

export interface BuildImageOptions {
  readonly recipeDir: string;
  readonly signingKeyFile: string;
  readonly outDir?: string;
  readonly publicBaseUrl?: string | URL;
  readonly purpose?: "development" | "distribution";
  readonly secrets?: readonly { readonly id: string; readonly file: string }[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImageBuildProgress) => void;
}

export type ImageBuildProgress =
  | { readonly phase: "resolve" | "build-rootfs" | "validate-files" | "package" | "sign" }
  | { readonly phase: "reproduce"; readonly run: 1 | 2 }
  | { readonly phase: "done"; readonly manifestSHA256: SHA256 };


export type ImageTestCheck =
  | "asset-integrity" | "manifest-signature" | "browser-features"
  | "runtime-ready" | "workspace-read-write" | "smoke-command"
  | "terminal-interrupt" | "persistence-reopen" | "preview"
  | "license-evidence" | "reproducible-build";

export type ImageCheckResult =
  | { readonly check: ImageTestCheck; readonly status: "passed" }
  | { readonly check: ImageTestCheck; readonly status: "failed"; readonly message: string }
  | { readonly check: ImageTestCheck; readonly status: "not-applicable"; readonly reason: "not-declared" | "mode-unsupported" };

export interface BrowserImageTestOptions {
  readonly image: ImageRef<RuntimeMode>;
  readonly browser: "chromium" | "firefox" | "webkit";
  readonly purpose?: "development" | "distribution";
  /** A local copy of the SDK's pinned engine release; otherwise OXIDEVM_ENGINE_DIR, the engine cache or the private release. */
  readonly engineDir?: string;
  readonly signal?: AbortSignal;
}

export interface ImageTestReport {
  readonly schemaVersion: 1;
  readonly result: "passed" | "failed";
  readonly mode: RuntimeMode;
  readonly manifestSHA256: SHA256;
  readonly engineRelease: string;
  readonly sdkVersion: string;
  readonly browser: { readonly name: "chromium" | "firefox" | "webkit"; readonly version: string };
  readonly checks: readonly ImageCheckResult[];
}

export interface ImageInspection {
  readonly mode: RuntimeMode;
  readonly id: string;
  readonly version: string;
  readonly manifestSHA256: SHA256;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly authentication:
    | { readonly kind: "verified"; readonly keyId: string }
    | { readonly kind: "unverified"; readonly keyId: string };
}


export interface ProjectConfig {
  readonly mode: RuntimeMode;
  readonly publicDir?: string;
  readonly assetBaseUrl?: string;
  /** Explicit image location and author trust. Required when this release has no managed image. */
  readonly image?: ImageLocation<RuntimeMode>;
}
