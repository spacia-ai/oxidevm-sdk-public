import { describe, expect, it } from "vitest";

import { validateRuntimeVMOptions, VMError } from "./index.js";
import { normalizeStorageError } from "./errors.js";
import { validateCoreProbeInput } from "./protocol.js";
import { normalizeWorkspacePath, validateWorkspaceId } from "./workspace-path.js";

describe("workspace trust boundary", () => {
  it("normalizes absolute and repeated separators", () => {
    expect(normalizeWorkspacePath("//src///app/page.tsx")).toEqual([
      "src",
      "app",
      "page.tsx",
    ]);
  });

  it("bounds UTF-8 path segments and complete paths", () => {
    expect(() => normalizeWorkspacePath("é".repeat(128))).toThrow(VMError);
    expect(() => normalizeWorkspacePath(Array.from({ length: 17 }, () => "a".repeat(255)).join("/"))).toThrow(VMError);
    expect(normalizeWorkspacePath("é".repeat(127))).toEqual(["é".repeat(127)]);
  });

  it.each(["../secret", "src/./file", "src\\file", "bad\0path"])(
    "rejects traversal and ambiguous paths: %s",
    (path) => {
      expect(() => normalizeWorkspacePath(path)).toThrow();
    },
  );

  it("allows stable opaque workspace identifiers", () => {
    expect(validateWorkspaceId("project_01-a")).toBe("project_01-a");
    expect(() => validateWorkspaceId("../../origin")).toThrow();
  });

  it.each([
    ["NotFoundError", "STORAGE_NOT_FOUND"],
    ["QuotaExceededError", "QUOTA_EXCEEDED"],
    ["NotAllowedError", "PERMISSION_DENIED"],
  ] as const)("maps %s at the storage boundary", (name, code) => {
    expect(normalizeStorageError(new DOMException(name, name)).code).toBe(code);
  });

  it("bounds synchronous diagnostic execution", () => {
    expect(() => validateCoreProbeInput(17, 1_000)).not.toThrow();
    expect(() => validateCoreProbeInput(17, 1_000_001)).toThrow();
    expect(() => validateCoreProbeInput(1_048_577, 1_000)).toThrow();
  });

  it.each([
    { mode: "invalid" },
    { mode: "system", vcpus: 0 },
    { mode: "system", vcpus: 1, network: "relay", relayUrl: "http://relay.test" },
  ])("rejects invalid runtime options before creating workers", (change) => {
    const defaults = {
      mode: "system",
      workspaceId: "test",
      memoryMiB: 512,
      vcpus: 1,
      network: "local",
    };
    const options = {
      ...defaults,
      ...change,
    };
    try {
      validateRuntimeVMOptions(options);
      throw new Error("expected invalid options");
    } catch (error) {
      expect(error).toBeInstanceOf(VMError);
      if (error instanceof VMError) {
        expect(error.code).toBe("INVALID_ARGUMENT");
      }
    }
  });

  it("rejects the retired userspace runtime", () => {
    try {
      validateRuntimeVMOptions({
        mode: "user",
        workspaceId: "test",
        memoryMiB: 512,
        network: "local",
        node: "24",
        pnpm: "11",
        cpuProfile: "x86-64-v3",
      });
      throw new Error("expected retired runtime rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(VMError);
      if (error instanceof VMError) {
        expect(error.code).toBe("INVALID_ARGUMENT");
      }
    }
  });

  it("accepts exact Userspace options and rejects cross-mode keys", () => {
    expect(validateRuntimeVMOptions({
      mode: "userspace",
      workspaceId: "test",
      memoryMiB: 512,
      network: "local",
      userspaceWasmUrl: "/userspace.wasm",
      previewOrigin: "http://127.0.0.1:4174",
      limits: { maxProcesses: 4 },
    })).toEqual({
      mode: "userspace",
      workspaceId: "test",
      memoryMiB: 512,
      network: "local",
      userspaceWasmUrl: "/userspace.wasm",
      previewOrigin: "http://127.0.0.1:4174",
      limits: { maxProcesses: 4 },
    });
    expect(() => validateRuntimeVMOptions({
      mode: "userspace",
      workspaceId: "test",
      memoryMiB: 512,
      network: "local",
      vcpus: 1,
    })).toThrow(VMError);
    expect(() => validateRuntimeVMOptions({
      mode: "userspace",
      workspaceId: "test",
      memoryMiB: 512,
      network: "local",
      previewOrigin: "http://preview.example/",
    })).toThrow(VMError);
    expect(() => validateRuntimeVMOptions({
      mode: "system",
      workspaceId: "test",
      memoryMiB: 512,
      network: "local",
      vcpus: 1,
      userspaceWasmUrl: "/userspace.wasm",
    })).toThrow(VMError);
  });

  it("allows insecure relay transport only on loopback", () => {
    expect(validateRuntimeVMOptions({
      mode: "userspace",
      workspaceId: "test",
      memoryMiB: 512,
      network: "relay",
      relayUrl: "http://127.0.0.1:8080/",
    })).toMatchObject({ network: "relay", relayUrl: "http://127.0.0.1:8080/" });
    expect(() => validateRuntimeVMOptions({
      mode: "userspace",
      workspaceId: "test",
      memoryMiB: 512,
      network: "relay",
      relayUrl: "http://relay.example/",
    })).toThrow(VMError);
  });
});
