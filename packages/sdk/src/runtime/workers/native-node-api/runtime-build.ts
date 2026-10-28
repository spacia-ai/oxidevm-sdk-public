import { VMError } from "../../errors.js";
import type { NativeProcessProfile } from "../../userspace-command-abi.js";
import type { ProcessRuntime } from "../assistance/process-runtime.js";
import { BUN_BUILD_CONFIG, NODE_BUILD_CONFIG } from "./runtime-build-data.js";
import { nativeBuildFeatures } from "./runtime-features.js";

function freezeTree(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of Reflect.ownKeys(value)) {
    const child: unknown = Reflect.get(value, key);
    freezeTree(child);
  }
  Object.freeze(value);
}

type BuildProfile = Pick<NativeProcessProfile, "runtime" | "runtimeSHA256">;

/** Rust authenticates this digest before publishing the process launch. */
function nativeBuildData(profile: BuildProfile) {
  const source = profile.runtime === "node" ? NODE_BUILD_CONFIG : BUN_BUILD_CONFIG;
  if (profile.runtimeSHA256 !== source.runtimeSHA256) throw new VMError("PROTOCOL_ERROR", "Native runtime build identity mismatch", { runtime: profile.runtime, runtimeSHA256: profile.runtimeSHA256 });
  return source;
}

export function nativeProcessBuild(profile: BuildProfile): NonNullable<ProcessRuntime["metadata"]["processBuild"]> {
  const source = nativeBuildData(profile);
  const value = structuredClone(source.config);
  if (profile.runtime === "node") freezeTree(value);
  else Object.freeze(value);
  return { config: { value, writable: profile.runtime === "bun", configurable: true }, features: nativeBuildFeatures(profile.runtime) };
}

export function nativeProcessVersions(profile: BuildProfile & Pick<NativeProcessProfile, "identity">) {
  const source = nativeBuildData(profile);
  // The legacy profile retains its NAPI declaration until its qualified replacement.
  return Object.freeze({ node: source.versions.node, uv: source.versions.uv,
    ...(profile.identity === "node24-bun1-v1" ? { napi: source.versions.napi } : {}),
    ...(profile.runtime === "bun" ? { bun: BUN_BUILD_CONFIG.versions.bun } : {}),
  });
}
