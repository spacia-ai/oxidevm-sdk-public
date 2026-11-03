/** What a module build can complain about. The set is closed so that a report reader can switch over it exhaustively. */
export const FINDING_CODES = [
  "module-source", "manifest-literal", "manifest-invalid",
  "adapter-bundle", "adapter-import", "adapter-stubbed", "adapter-size", "adapter-meta", "adapter-global", "adapter-eval", "adapter-network",
  "artifact-missing", "artifact-unsafe", "artifact-size",
  "license-source", "license-bundled", "notices-missing", "output-unsafe",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
export type Severity = "error" | "warning";

/** Where in the author's tree a finding points; absent parts are simply not known. */
export interface Location {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface Finding extends Location {
  readonly severity: Severity;
  readonly code: FindingCode;
  readonly message: string;
}

/** The longest message a finding carries; longer text is cut so a report always fits its decoder. */
export const MAX_FINDING_MESSAGE = 2000;

/** What the build report carries about each bundled package; the decoder and the code that fills the list share these bounds. */
export const MAX_PACKAGE_NAME = 214;
export const MAX_PACKAGE_VERSION = 128;
export const MAX_PACKAGE_LICENSE = 256;
export const MAX_BUNDLED_PACKAGES = 256;

export function finding(severity: Severity, code: FindingCode, message: string, location: Location = {}): Finding {
  return { severity, code, message: message.length > MAX_FINDING_MESSAGE ? `${message.slice(0, MAX_FINDING_MESSAGE - 3)}...` : message, ...location };
}

/** Stops a build at a stage that cannot continue. `buildModule` turns it into a failed result, so authors see findings, not stack traces. */
export class BuildFailure extends Error {
  readonly findings: readonly Finding[];

  constructor(findings: readonly Finding[]) {
    super(findings.map(item => item.message).join("; "));
    this.name = "BuildFailure";
    this.findings = findings;
  }
}

export function failure(code: FindingCode, message: string, location: Location = {}): never {
  throw new BuildFailure([finding("error", code, message, location)]);
}
