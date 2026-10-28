import type { LicenseStatus, VM } from "../../../src/contracts.js";
import { VMError } from "../../../src/runtime/errors.js";

// The runtime frame's boot ping (ADR 0021): one cookie-less beacon per created VM with exactly these
// fields, to the frame's own origin (the build constant OXIDEVM_TELEMETRY_ENDPOINT, /__t/v1/boot by
// default), so only Spacia's run.oxidevm.dev records it. The fields are published at
// https://run.oxidevm.dev/telemetry.

export interface BootPing {
  readonly v: 1;
  readonly embedderOrigin: string;
  readonly sdkVersion: string;
  readonly engineReleaseId: string;
  readonly mode: "system" | "linux-user";
  readonly tier: LicenseStatus["tier"] | "refused";
  readonly licenseId: string | null;
  readonly outcome: string;
  readonly bootMsBucket: number;
}

/** Boot times reported only as the bucket they fall in, in milliseconds. */
const BUCKETS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000] as const;

export function bootBucket(milliseconds: number): number {
  return BUCKETS.find(bucket => milliseconds <= bucket) ?? 1_000_000;
}

export interface BootReport {
  readonly embedderOrigin: string;
  readonly sdkVersion: string;
  readonly engineReleaseId: string;
  readonly mode: "system" | "userspace";
  readonly milliseconds: number;
  readonly result: { readonly vm: Pick<VM, "license"> } | { readonly error: unknown };
}

/**
 * The wire value the telemetry Worker accepts. The userspace runtime still reports `userspace` here until the
 * Worker accepts the new value (naming decision F1b); this is the one place that produces it.
 */
function wireMode(mode: BootReport["mode"]): BootPing["mode"] {
  return mode === "userspace" ? "linux-user" : "system";
}

/** The ping for a boot, or `undefined` when the license opts out of telemetry. */
export function bootPing(report: BootReport): BootPing | undefined {
  const license = "vm" in report.result ? report.result.vm.license : undefined;
  if (license?.tier === "licensed" && !license.telemetry) return undefined;
  const refused = "error" in report.result && report.result.error instanceof VMError && report.result.error.code === "PERMISSION_DENIED";
  return {
    v: 1, embedderOrigin: report.embedderOrigin, sdkVersion: report.sdkVersion, engineReleaseId: report.engineReleaseId, mode: wireMode(report.mode),
    tier: refused ? "refused" : license?.tier ?? "free",
    licenseId: license?.tier === "licensed" ? license.licenseId : null,
    outcome: "vm" in report.result ? "booted" : report.result.error instanceof VMError ? report.result.error.code : "UNKNOWN",
    bootMsBucket: bootBucket(report.milliseconds),
  };
}

/** Sends the ping when an endpoint is configured; never throws, never retries, never stores. */
export function sendBootPing(endpoint: string, ping: BootPing | undefined): void {
  if (endpoint === "" || ping === undefined) return;
  try { navigator.sendBeacon(endpoint, new Blob([JSON.stringify(ping)], { type: "text/plain" })); } catch { /* offline or refused: dropped */ }
}
