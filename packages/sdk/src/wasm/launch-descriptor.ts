import { record } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decoding } from "./decode-support.js";
import { decodeResolvedManifest, isServiceDecl } from "./manifest.js";
import type { ResolvedManifest } from "./manifest-types.js";
import { OPTIONS_INVALID, resolveOptions } from "./options.js";
import { decodeLaunchDescriptor, type LaunchDescriptor } from "./runner/descriptor.js";

/**
 * What the module runner starts from, built from an installed module's handle on the page. `spawnModule` sends it in
 * the runner's start message, and `enableModuleCommands` hands it to the VM's registration, which every run of the
 * module's commands starts from (engine ADR 0027). Every failure here is INVALID_ARGUMENT, before anything is fetched
 * or started.
 */

/** The `module.json` a handle carries: INVALID_ARGUMENT `wasm-manifest-invalid` when the handle does not carry one. */
export function handleManifest(handle: unknown): ResolvedManifest {
  return decoding("module handle", () => decodeResolvedManifest(record(handle, "module handle")["manifest"]));
}

/**
 * The launch description of `handle` with the consumer's options resolved against its manifest, defaults included, so
 * a bad option fails here (`wasm-module-options`) and the runner receives the values it will use. The handle's pins
 * must say exactly what its manifest says about each file (`wasm-manifest-invalid` otherwise).
 */
export function launchDescriptor(handle: unknown, input: { readonly options: unknown; readonly workspaceId: string | undefined }): LaunchDescriptor {
  const manifest = handleManifest(handle);
  const options = resolveOptions(manifest.options, input.options);
  if (isServiceDecl(manifest) && manifest.process.exclusive === "workspace" && input.workspaceId === undefined) {
    throw new VMError("INVALID_ARGUMENT", `${manifest.id} is exclusive per workspace: pass workspaceId`, { reason: OPTIONS_INVALID });
  }
  const pins = decoding("module handle", () => record(record(handle, "module handle")["pins"], "module handle pins"));
  return decodeLaunchDescriptor({
    v: 1, manifest, release: pins["release"], adapter: pins["adapter"], artifacts: pins["artifacts"], options,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  });
}
