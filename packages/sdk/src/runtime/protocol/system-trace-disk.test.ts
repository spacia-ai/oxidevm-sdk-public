import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { decodeSystemTraceDiskProfile } from "./system-trace-disk.js";

const profile = {
  enabled: true,
  requests: 1,
  failures: 1,
  reads: 1,
  readBytes: 4096,
  writes: 0,
  writtenBytes: 0,
  zeroes: 0,
  zeroedBytes: 0,
  discards: 0,
  discardedBytes: 0,
  flushes: 0,
  waitMilliseconds: 1,
  maximumWaitMilliseconds: 1,
  maximumQueueDepth: 1,
  busyReturns: 0,
  maximumInFlight: 1,
  delayedFailures: 1,
  backendFailures: 1,
  protocolFailures: 0,
  timeoutFailures: 0,
  stickyFailure: {
    sequence: 7,
    reason: "backend",
    operation: "read",
    offset: 4096,
    length: 4096,
  },
} as const;

describe("system trace disk profile", () => {
  it("decodes an exact v30 sticky command identity", () => {
    expect(decodeSystemTraceDiskProfile(profile, 30).stickyFailure).toEqual(
      profile.stickyFailure,
    );
  });

  it("rejects the v30 identity in legacy evidence", () => {
    expect(() => decodeSystemTraceDiskProfile(profile, 29)).toThrow(
      VMError,
    );
  });

  it("decodes a v34 quota failure as its own reason and counter", () => {
    const quota = { ...profile, backendFailures: 0, quotaFailures: 1,
      stickyFailure: { ...profile.stickyFailure, reason: "quota", operation: "write" } } as const;
    expect(decodeSystemTraceDiskProfile(quota, 34)).toEqual(quota);
  });

  it("rejects the quota reason and counter in v33 evidence", () => {
    expect(() => decodeSystemTraceDiskProfile({ ...profile, quotaFailures: 0 }, 33)).toThrow(VMError);
    expect(() => decodeSystemTraceDiskProfile(
      { ...profile, stickyFailure: { ...profile.stickyFailure, reason: "quota" } }, 33)).toThrow(VMError);
  });

  it("rejects a partial v30 command identity", () => {
    expect(() =>
      decodeSystemTraceDiskProfile(
        {
          ...profile,
          stickyFailure: {
            sequence: 7,
            reason: "backend",
            operation: "read",
          },
        },
        30,
      ),
    ).toThrow(VMError);
  });
});
