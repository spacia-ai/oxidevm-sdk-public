import { describe, expect, it } from "vitest";
import type { SystemImageRecipe, UserspaceImageRecipe } from "./contracts.js";
import { decodeImageRecipe } from "./recipe.js";

const base = { id: "python", version: "1", mode: "userspace", source: { kind: "directory", path: "rootfs" }, smokeTest: { command: "/usr/bin/python3", expectedExitCode: 0 } };
function thrown(run: () => unknown): unknown {
  try { run(); } catch (error: unknown) { return error; }
  throw new Error("expected the call to throw");
}

describe("recipe boundary", () => {
  it("accepts all rootfs adapters without requiring Node", () => {
    for (const source of [base.source, { kind: "archive", artifact: { path: "root.tar", sha256: "a".repeat(64) } }, { kind: "oci", reference: `alpine@sha256:${"a".repeat(64)}` }, { kind: "dockerfile", context: ".", file: "Dockerfile" }]) {
      expect(decodeImageRecipe({ ...base, source }).source).toEqual(source);
    }
  });
  it("accepts explicit boot files only for System", () => {
    const artifact = { path: "file", sha256: "a".repeat(64) };
    const source = { kind: "boot-files", kernel: artifact, disk: artifact, commandLine: "console=hvc0" };
    expect(decodeImageRecipe({ ...base, mode: "system", source }).source.kind).toBe("boot-files");
    expect(() => decodeImageRecipe({ ...base, source })).toThrow();
  });
  it.each([
    null, { ...base, mode: "auto" }, { ...base, typo: true }, { ...base, boot: {} },
    { ...base, resources: { maxProcesses: 0 } }, { ...base, resources: { memoryMiB: 1 } },
    { ...base, smokeTest: { command: "python", expectedExitCode: 1 } },
    { ...base, mode: "system" }, { ...base, sourceDateEpoch: -1 },
  ])("rejects malformed input before tools or writes: %j", value => {
    expect(() => decodeImageRecipe(value)).toThrow();
  });
});

describe("Userspace workspace ownership", () => {
  it("decodes an explicit owner across the full ID range and leaves an absent one to the builder default", () => {
    expect(decodeImageRecipe({ ...base, workspace: { ownership: { uid: 0, gid: 4_294_967_294 } } })).toMatchObject({ workspace: { ownership: { uid: 0, gid: 4_294_967_294 } } });
    expect(decodeImageRecipe(base)).not.toHaveProperty("workspace");
  });
  it.each([
    null, {}, { ownership: null }, { ownership: { uid: 1000 } }, { ownership: { uid: 1000, gid: 1000 }, mode: 0o755 },
    { ownership: { uid: 1000, gid: 1000, mode: 0o755 } }, { ownership: { uid: -1, gid: 1000 } }, { ownership: { uid: 1000, gid: 4_294_967_295 } },
    { ownership: { uid: 1000.5, gid: 1000 } }, { ownership: { uid: "1000", gid: 1000 } },
  ])("rejects workspace %j as an invalid argument", workspace => {
    expect(thrown(() => decodeImageRecipe({ ...base, workspace }))).toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("rejects workspace ownership in System recipes, whose disk records its own owners", () => {
    const system = { ...base, mode: "system", boot: { kernel: { kind: "managed-default" } } };
    const bootFiles = { ...base, mode: "system", source: { kind: "boot-files", kernel: { path: "kernel", sha256: "a".repeat(64) }, disk: { path: "disk", sha256: "b".repeat(64) }, commandLine: "console=hvc0" } };
    for (const recipe of [system, bootFiles]) {
      expect(decodeImageRecipe(recipe).mode).toBe("system");
      expect(thrown(() => decodeImageRecipe({ ...recipe, workspace: { ownership: { uid: 1000, gid: 1000 } } }))).toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });
});

/** Strict test-project compile contract: only Userspace recipes name a workspace owner. */
function workspaceContract(): readonly (UserspaceImageRecipe | SystemImageRecipe)[] {
  const smokeTest = { command: "/bin/true", expectedExitCode: 0 } as const;
  const source = { kind: "directory", path: "rootfs" } as const;
  return [
    { id: "user", version: "1", mode: "userspace", source, workspace: { ownership: { uid: 1000, gid: 1000 } }, smokeTest } satisfies UserspaceImageRecipe,
    { id: "system", version: "1", mode: "system", source, boot: { kernel: { kind: "managed-default" } }, smokeTest } satisfies SystemImageRecipe,
    // @ts-expect-error a System disk records its own workspace owners
    { id: "system", version: "1", mode: "system", source, boot: { kernel: { kind: "managed-default" } }, workspace: { ownership: { uid: 1000, gid: 1000 } }, smokeTest } satisfies SystemImageRecipe,
  ];
}
it("keeps the compiler-checked workspace recipe contract", () => { expect(workspaceContract()).toHaveLength(3); });
