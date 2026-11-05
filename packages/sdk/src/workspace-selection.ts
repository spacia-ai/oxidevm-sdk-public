import type { StorageScope } from "./runtime/storage-scope.js";
import { openDurableOrTemporary } from "./runtime/workspace-lease.js";
import { onTemporaryWorkspace, type ValidatedVMOptions } from "./vm-options.js";

/**
 * Opens a VM with `open` on the workspace its options name. With `workspaceInUse: "temporary"`, a
 * durable workspace another VM of `storage` holds is not waited for: the VM opens on a new temporary
 * workspace instead and reports why (`workspace-in-use`).
 */
export function openOnWorkspace<T>(options: ValidatedVMOptions, storage: StorageScope, open: (options: ValidatedVMOptions) => Promise<T>): Promise<T> {
  if (options.ephemeral !== false || options.workspaceInUse === "fail") return open(options);
  return openDurableOrTemporary(storage, options.workspaceId, temporary => open(temporary ? onTemporaryWorkspace(options) : options));
}
