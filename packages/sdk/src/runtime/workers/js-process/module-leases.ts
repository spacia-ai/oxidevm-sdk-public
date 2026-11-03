import { VMError } from "../../errors.js";
import { isServiceDecl } from "../../../wasm/manifest.js";
import type { LaunchDescriptor } from "../../../wasm/runner/descriptor.js";

/**
 * Exclusive-service leases (engine ADR 0028, "Exclusive services"). A service whose manifest says
 * `process.exclusive: "workspace"` runs at most once per workspace and module, across every VM and tab of the page's
 * origin. The Userspace worker takes the lease, a Web Lock of its own origin, before the process is admitted, and holds
 * it until the process ends; module code, which runs in an opaque module frame, can neither hold nor steal it.
 */

/** Stable `detail.reason` of a start refused because another process holds the lease. */
export const MODULE_BUSY_REASON = "wasm-module-busy";
/** Stable `detail.reason` of a start this worker cannot lease: it has no Web Locks. */
export const MODULE_PREREQUISITE_REASON = "wasm-module-prerequisite";

/** A held lease; releasing it twice does nothing. */
export interface ModuleLease { release(): void }

/** The Web Locks of the worker's own origin: `navigator.locks` unless a test supplies one. */
export type LeaseLocks = Pick<LockManager, "request">;

/** The lease's name: one per workspace and module. */
export function leaseName(descriptor: LaunchDescriptor): string | undefined {
  const { manifest } = descriptor;
  if (!isServiceDecl(manifest) || manifest.process.exclusive !== "workspace") return undefined;
  if (descriptor.workspaceId === undefined) throw new VMError("INVALID_ARGUMENT", `${manifest.id} is exclusive per workspace: pass workspaceId`, { reason: "wasm-module-options" });
  return `oxidevm-module:${descriptor.workspaceId}:${manifest.id}`;
}

/**
 * Takes the lease `descriptor` needs, or none for a module that is not exclusive. Another holder makes it
 * QUOTA_EXCEEDED `wasm-module-busy`, before anything else of the start happens.
 */
export async function takeModuleLease(descriptor: LaunchDescriptor, locks: LeaseLocks | undefined): Promise<ModuleLease | undefined> {
  const name = leaseName(descriptor);
  if (name === undefined) return undefined;
  if (locks === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Exclusive services need Web Locks in the VM's worker", { reason: MODULE_PREREQUISITE_REASON });
  const taken = Promise.withResolvers<ModuleLease>(), released = Promise.withResolvers<undefined>();
  const held = locks.request(name, { ifAvailable: true }, async lock => {
    if (lock === null) { taken.reject(new VMError("QUOTA_EXCEEDED", `${descriptor.manifest.id} is already running in this workspace`, { reason: MODULE_BUSY_REASON })); return; }
    let done = false;
    taken.resolve({ release: () => { if (done) return; done = true; released.resolve(undefined); } });
    await released.promise;
  });
  held.catch((error: unknown) => { taken.reject(error instanceof Error ? error : new VMError("FEATURE_NOT_AVAILABLE", "The workspace lease could not be taken", { reason: MODULE_PREREQUISITE_REASON })); });
  return taken.promise;
}
