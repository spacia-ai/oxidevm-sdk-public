import { describe, expect, it } from "vitest";
import { decodeUserspaceRequest, userspaceResponseDecoders } from "../userspace-protocol.js";
import { PROTOCOL_VERSION } from "./common.js";
import { decodeModuleCommandsResult } from "./userspace-module-commands.js";

const base = { id: 7, version: PROTOCOL_VERSION, type: "module-commands" } as const;
const enable = { ...base, operation: "enable", descriptor: "{\"v\":1}", commands: ["python", "python3"], concurrency: 4, files: { [`${"d".repeat(64)}:3`]: new Blob(["abc"]) } } as const;

describe("the module-commands request (worker protocol 178)", () => {
  it("decodes enable, disable and status with exactly their fields", () => {
    expect(decodeUserspaceRequest(enable)).toEqual(enable);
    for (const operation of ["disable", "status"] as const) expect(decodeUserspaceRequest({ ...base, operation, registration: 3 })).toEqual({ ...base, operation, registration: 3 });
    expect(decodeUserspaceRequest({ ...enable, commands: ["a"], concurrency: 1 })).toMatchObject({ commands: ["a"], concurrency: 1 });
    expect(decodeUserspaceRequest({ ...enable, concurrency: 32, descriptor: "x".repeat(512 * 1024) })).toMatchObject({ concurrency: 32 });
  });

  it("refuses malformed, extra and out-of-range fields at the worker boundary", () => {
    for (const invalid of [
      { ...enable, version: PROTOCOL_VERSION - 1 }, { ...enable, operation: "toggle" }, { ...enable, extra: true },
      { ...base, operation: "enable", commands: ["a"], concurrency: 4 }, { ...enable, descriptor: 1 }, { ...enable, descriptor: "é".repeat(256 * 1024 + 1) },
      { ...enable, commands: [] }, { ...enable, commands: ["a", "a"] }, { ...enable, commands: ["Python"] }, { ...enable, commands: ["oxidevm-x"] },
      { ...enable, commands: Array.from({ length: 17 }, (_, index) => `c${String(index)}`) }, { ...enable, commands: "python" },
      { ...enable, concurrency: 0 }, { ...enable, concurrency: 33 }, { ...enable, concurrency: 1.5 },
      // ADR 0028: an enable carries the copies the VM's store lacked, by key; worker protocol 177 had none.
      { ...base, operation: "enable", descriptor: "{}", commands: ["a"], concurrency: 4 }, { ...enable, files: { "x:3": new Blob([]) } }, { ...enable, files: { [`${"d".repeat(64)}:3`]: "abc" } },
      { ...base, operation: "disable", registration: 0 }, { ...base, operation: "status", registration: 2 ** 32 }, { ...base, operation: "status" },
      { ...base, operation: "disable", registration: 1, descriptor: "{}" },
    ]) expect(() => decodeUserspaceRequest(invalid), JSON.stringify(invalid).slice(0, 120)).toThrow();
  });

  it("decodes each answer by the operation it names", () => {
    expect(userspaceResponseDecoders["module-commands"]).toBe(decodeModuleCommandsResult);
    const enabled = { operation: "enable", registration: 2, commands: ["python", "python3"], skipped: [{ name: "python3", reason: "occupied" }] } as const;
    expect(decodeModuleCommandsResult(enabled)).toEqual(enabled);
    expect(decodeModuleCommandsResult({ operation: "disable" })).toEqual({ operation: "disable" });
    const status = { operation: "status", enabled: true, skipped: [{ name: "python", reason: "unavailable" }] } as const;
    expect(decodeModuleCommandsResult(status)).toEqual(status);
    expect(decodeModuleCommandsResult({ operation: "status", enabled: false, skipped: [] })).toEqual({ operation: "status", enabled: false, skipped: [] });
    for (const invalid of [
      undefined, { ...enabled, extra: 1 }, { ...enabled, registration: 0 }, { ...enabled, commands: [] }, { ...enabled, skipped: [{ name: "typst", reason: "occupied" }] },
      { ...enabled, skipped: [{ name: "python3", reason: "missing" }] }, { ...enabled, skipped: [{ name: "python3", reason: "occupied" }, { name: "python3", reason: "occupied" }] },
      { operation: "disable", registration: 2 }, { ...status, enabled: "yes" }, { operation: "status", enabled: false, skipped: [{ name: "python", reason: "occupied" }] },
      { operation: "unknown" },
    ]) expect(() => decodeModuleCommandsResult(invalid), JSON.stringify(invalid)).toThrow();
  });
});
