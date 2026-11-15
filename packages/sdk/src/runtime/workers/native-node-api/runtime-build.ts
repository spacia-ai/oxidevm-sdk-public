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

type BuildProfile = Pick<NativeProcessProfile, "runtime" | "runtimeSHA256" | "runtimeBuild">;

/** Rust authenticates this digest before publishing the process launch. */
function nativeBuildData(profile: BuildProfile) {
  const source = profile.runtime === "node" ? NODE_BUILD_CONFIG : BUN_BUILD_CONFIG;
  if (profile.runtimeSHA256 !== source.runtimeSHA256) throw new VMError("PROTOCOL_ERROR", "Native runtime build identity mismatch", { runtime: profile.runtime, runtimeSHA256: profile.runtimeSHA256 });
  return source;
}

/** A probed binary's build (ADR 0026, 1.5); the catalog builds' data travels with the SDK. */
function buildVersions(profile: BuildProfile): { readonly node: string; readonly uv: string; readonly napi: string; readonly bun: string } {
  if (profile.runtimeBuild !== null) return profile.runtimeBuild;
  const source = nativeBuildData(profile);
  return { node: source.versions.node, uv: source.versions.uv, napi: source.versions.napi, bun: BUN_BUILD_CONFIG.versions.bun };
}

export function nativeProcessBuild(profile: BuildProfile): NonNullable<ProcessRuntime["metadata"]["processBuild"]> {
  // The decoder checked that a probed configuration is the JSON text of an object.
  const value: unknown = profile.runtimeBuild === null ? structuredClone(nativeBuildData(profile).config) : JSON.parse(profile.runtimeBuild.config);
  if (typeof value !== "object" || value === null) throw new VMError("PROTOCOL_ERROR", "Invalid native runtime configuration");
  if (profile.runtime === "node") freezeTree(value);
  else Object.freeze(value);
  return { config: { value, writable: profile.runtime === "bun", configurable: true }, features: nativeBuildFeatures(profile.runtime) };
}

export function nativeProcessVersions(profile: BuildProfile & Pick<NativeProcessProfile, "identity">) {
  const source = buildVersions(profile);
  // The legacy profile retains its NAPI declaration until its qualified replacement.
  return Object.freeze({ node: source.node, uv: source.uv,
    ...(profile.identity === "node24-bun1-v1" ? { napi: source.napi } : {}),
    ...(profile.runtime === "bun" ? { bun: source.bun } : {}),
  });
}
