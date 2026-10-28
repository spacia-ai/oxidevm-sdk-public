import { expect, it } from "vitest";
import { decodeUserspaceRequest } from "./userspace-protocol.js";
import { PROTOCOL_VERSION } from "./protocol/common.js";
import { decodeJitTierOption, JIT_TIER_OPTION } from "./jit-tier-option.js";
import { configureMountedRuntime, mountSettings, UNCONFIGURED_MOUNT } from "./workers/userspace-settings.js";

it("keeps Userspace Tier 1 by default and validates the experimental option", () => {
  expect(decodeJitTierOption({})).toBeUndefined();
  for (const tier of ["tier1", "tier2"] as const) {
    expect(decodeJitTierOption({ [JIT_TIER_OPTION]: tier })).toBe(tier);
  }
  for (const tier of [null, 2, "Tier2", "tier3", {}]) {
    expect(() => decodeJitTierOption({ [JIT_TIER_OPTION]: tier })).toThrowError();
  }
});

it("rejects a runtime that did not admit the requested tier", () => {
  const exports = { oxidevm_userspace_jit_configure: () => 0, oxidevm_userspace_jit_tier: () => 1 };
  expect(() => configureMountedRuntime({ exports }, { ...UNCONFIGURED_MOUNT, jitTier: "tier2" }, false))
    .toThrowError("Userspace JIT tier was not admitted");
});

it("decodes the tier at the worker boundary and carries it into fresh mounts", () => {
  const request = { id: 1, version: PROTOCOL_VERSION, type: "initialize", wasmUrl: "/userspace.wasm", memoryMiB: 512 };
  for (const tier of [undefined, "tier1", "tier2"] as const) {
    const decoded = decodeUserspaceRequest({ ...request, ...(tier === undefined ? {} : { jitTier: tier }) });
    if (decoded.type !== "initialize") throw new Error("initialize expected");
    expect(mountSettings(decoded).jitTier).toBe(tier ?? "tier1");
  }
  expect(() => decodeUserspaceRequest({ ...request, jitTier: "tier3" })).toThrowError();
});
