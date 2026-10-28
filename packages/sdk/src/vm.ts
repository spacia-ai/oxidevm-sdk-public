import type { CreateVMOptions, SystemOptions, SystemVM, UserspaceOptions, UserspaceVM, VM } from "./contracts.js";
import { abortIfRequested } from "./engine-assets.js";
import { decodePublicVMOptions } from "./vm-options.js";

export function createVM(options: SystemOptions): Promise<SystemVM>;
export function createVM(options: UserspaceOptions): Promise<UserspaceVM>;
export function createVM(options: CreateVMOptions): Promise<VM>;
export async function createVM(input: CreateVMOptions): Promise<VM> {
  const options = decodePublicVMOptions(input); abortIfRequested(options.signal);
  // Each path loads only its own code: a page using the runtime frame never downloads the runtime.
  if (options.runtime.hosting === "frame") {
    const { createFrameVM } = await import("./frame/client/frame-vm.js");
    return createFrameVM(options, options.runtime);
  }
  const { createLocalVM } = await import("./local-vm.js");
  return createLocalVM(options, options.runtime.baseUrl);
}
