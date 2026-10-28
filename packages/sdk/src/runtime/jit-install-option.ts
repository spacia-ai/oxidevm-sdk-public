import { VMError } from "./errors.js";
import {
  isJitInstallMode,
  type SystemJitInstallMode,
} from "./protocol/system-trace-background-compile.js";

/** The internal option a diagnostic page sets on `RuntimeVMOptions` to choose how Tier-1
 * modules are installed (`jit-install=…`), for same-build A/B evidence. */
export const JIT_INSTALL_OPTION = Symbol.for("oxidevm.internal.jit-install");

/** The JIT install mode `options` asks for, when it asks for one. */
export function decodeJitInstallOption(options: object): SystemJitInstallMode | undefined {
  const value: unknown = Reflect.get(options, JIT_INSTALL_OPTION);
  if (value === undefined) return undefined;
  if (!isJitInstallMode(value)) {
    throw new VMError("INVALID_ARGUMENT", "JIT install mode is invalid");
  }
  return value;
}
