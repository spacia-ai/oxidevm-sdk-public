import { describe, expect, it } from "vitest";
import { VMError } from "../../../src/runtime/errors.js";
import { bootBucket, bootPing } from "./telemetry.js";

const base = { embedderOrigin: "https://app.example.com", sdkVersion: "0.1.0-alpha.4", engineReleaseId: "a".repeat(64), mode: "userspace", milliseconds: 7_000 } as const;

describe("runtime frame boot ping", () => {
  it("reports exactly the documented fields for a free boot", () => {
    expect(bootPing({ ...base, result: { vm: { license: { tier: "free" } } } })).toEqual({
      v: 1, embedderOrigin: "https://app.example.com", sdkVersion: "0.1.0-alpha.4", engineReleaseId: "a".repeat(64), mode: "linux-user",
      tier: "free", licenseId: null, outcome: "booted", bootMsBucket: 10_000,
    });
  });
  it("names the license, and sends nothing when the license opts out", () => {
    const license = { tier: "licensed", licenseId: "0".repeat(32), licensee: "X", expiresAt: 1, validUntil: 604801, commercial: true, validity: "active", selfHost: false, telemetry: true } as const;
    expect(bootPing({ ...base, result: { vm: { license } } })).toMatchObject({ tier: "licensed", licenseId: "0".repeat(32) });
    expect(bootPing({ ...base, result: { vm: { license: { ...license, telemetry: false } } } })).toBeUndefined();
  });
  it("reports failures by code and refusals as their own tier", () => {
    expect(bootPing({ ...base, result: { error: new VMError("QUOTA_EXCEEDED", "full") } })).toMatchObject({ tier: "free", outcome: "QUOTA_EXCEEDED" });
    expect(bootPing({ ...base, result: { error: new VMError("PERMISSION_DENIED", "no") } })).toMatchObject({ tier: "refused", outcome: "PERMISSION_DENIED" });
    expect(bootPing({ ...base, result: { error: new Error("x") } })).toMatchObject({ outcome: "UNKNOWN" });
  });
  it("sends the wire value the deployed Worker accepts for each runtime", () => {
    expect(bootPing({ ...base, mode: "system", result: { vm: { license: { tier: "free" } } } })).toMatchObject({ mode: "system" });
    expect(bootPing({ ...base, mode: "userspace", result: { vm: { license: { tier: "free" } } } })).toMatchObject({ mode: "linux-user" });
  });
  it("reports boot time only as a bucket", () => {
    expect([1, 5_000, 5_001, 159_999, 500_000].map(bootBucket)).toEqual([5_000, 5_000, 10_000, 160_000, 1_000_000]);
  });
});
