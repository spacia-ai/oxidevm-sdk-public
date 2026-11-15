import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { nativeProcessBuild, nativeProcessVersions } from "./runtime-build.js";

const node = { runtime: "node", runtimeSHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", runtimeBuild: null } as const;
const bun = { runtime: "bun", runtimeSHA256: "500e6edbf321ddf490adcc55a6a01639993a07924616ab67492e1256c15557e2", runtimeBuild: null } as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

it("matches every pinned Node build flag and freezes its entire config tree", () => {
  const build = nativeProcessBuild(node).config;
  expect(digest(build.value)).toBe("a720edbc87bf72b8507ffdad5bed967b11c3d39d862dc975dcc3528b48f246f6");
  expect(build.writable).toBe(false);
  function frozen(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    expect(Object.isFrozen(value)).toBe(true);
    for (const key of Reflect.ownKeys(value)) { const child: unknown = Reflect.get(value, key); frozen(child); }
  }
  frozen(build.value);
});

it("preserves Bun's distinct flags, shallow freeze and private mutable variables", () => {
  const first = nativeProcessBuild(bun).config, second = nativeProcessBuild(bun).config;
  expect(digest(first.value)).toBe("dd8debdff83b549e9befb57f594a87901a8093265c5e30c8d0dc39fdc9c6949d");
  expect(first.writable).toBe(true); expect(Object.isFrozen(first.value)).toBe(true);
  const variables: unknown = Reflect.get(first.value, "variables");
  if (typeof variables !== "object" || variables === null) throw new Error("Missing Bun config variables");
  expect(Object.isFrozen(variables)).toBe(false);
  expect(Reflect.set(variables, "target_arch", "changed")).toBe(true);
  expect(digest(second.value)).toBe("dd8debdff83b549e9befb57f594a87901a8093265c5e30c8d0dc39fdc9c6949d");
  expect(digest(nativeProcessBuild(bun).config.value)).toBe(digest(second.value));
});

it("rejects stale or mismatched runtime identities instead of substituting build flags", () => {
  for (const profile of [{ ...node, runtimeSHA256: bun.runtimeSHA256 }, { ...bun, runtimeSHA256: node.runtimeSHA256 }, { ...node, runtimeSHA256: "0".repeat(64) }]) {
    let error: unknown; try { nativeProcessBuild(profile); } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: "PROTOCOL_ERROR" });
  }
});

it.each([
  { profile: node, expected: { node: "24.18.1", uv: "1.52.1", napi: "10" } },
  { profile: bun, expected: { node: "24.3.0", uv: "1.48.0", napi: "10", bun: "1.3.14" } },
])("matches captured build versions for the managed $profile.runtime executable", ({ profile, expected }) => {
  const versions = nativeProcessVersions({ ...profile, identity: "node24-bun1-v1" });
  expect(versions).toEqual(expected); expect(Object.isFrozen(versions)).toBe(true);
  expect(Reflect.set(versions, "uv", "wrong")).toBe(false);
  expect(nativeProcessVersions({ ...profile, identity: "node24-bun1-v1" })).toEqual(expected);
});

it.each([node, bun])("does not advertise a general Node-API version for a generic $runtime profile", profile => {
  const versions = nativeProcessVersions({ ...profile, identity: "native-parity-fixture-v1" });
  expect(Object.hasOwn(versions, "napi")).toBe(false);
  expect(versions.uv).toBe(profile.runtime === "node" ? "1.52.1" : "1.48.0");
});

it("rejects mismatched executable bytes before returning version metadata", () => {
  for (const profile of [{ ...node, runtimeSHA256: bun.runtimeSHA256 }, { ...bun, runtimeSHA256: node.runtimeSHA256 }]) {
    let error: unknown;
    try { nativeProcessVersions({ ...profile, identity: "node24-bun1-v1" }); } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: "PROTOCOL_ERROR" });
  }
});

it("presents a probed binary's own build in place of the catalog data (ADR 0026, 1.5)", () => {
  const config = '{"target_defaults":{"cflags":[]},"variables":{"node_module_version":137}}';
  const probed = { runtime: "node", runtimeSHA256: "b".repeat(64), runtimeBuild: { version: "v24.11.0", node: "24.11.0", uv: "1.51.0", napi: "10", bun: "", config } } as const;
  expect(nativeProcessVersions({ ...probed, identity: "node24-bun1-v1" })).toEqual({ node: "24.11.0", uv: "1.51.0", napi: "10" });
  const build = nativeProcessBuild(probed).config;
  expect(build.value).toEqual({ target_defaults: { cflags: [] }, variables: { node_module_version: 137 } });
  expect(build.writable).toBe(false);
  const variables: unknown = Reflect.get(build.value, "variables");
  expect(Object.isFrozen(build.value) && typeof variables === "object" && variables !== null && Object.isFrozen(variables)).toBe(true);
  const probedBun = { runtime: "bun", runtimeSHA256: "c".repeat(64), runtimeBuild: { version: "v24.3.0", node: "24.3.0", uv: "1.48.0", napi: "10", bun: "1.3.2", config } } as const;
  expect(nativeProcessVersions({ ...probedBun, identity: "node24-bun1-v1" })).toEqual({ node: "24.3.0", uv: "1.48.0", napi: "10", bun: "1.3.2" });
  const bunBuild = nativeProcessBuild(probedBun).config;
  expect(bunBuild.writable).toBe(true);
  const bunVariables: unknown = Reflect.get(bunBuild.value, "variables");
  expect(Object.isFrozen(bunBuild.value) && typeof bunVariables === "object" && bunVariables !== null && !Object.isFrozen(bunVariables)).toBe(true);
});
