/**
 * The names of module commands (engine ADR 0027): the grammar Rust enforces for a VM's module-command table and the one
 * directory that holds every stub. Environment-neutral, so the manifest decoder, the install review and the worker
 * codecs share one owner.
 */

/** A module command's name, which is also its stub's file name; names with the reserved prefix are refused too. */
export const MODULE_COMMAND_NAME = /^[a-z0-9][a-z0-9_.+-]{0,63}$/u;
/** Names that start with this prefix belong to OxideVM. */
export const RESERVED_COMMAND_PREFIX = "oxidevm";

export function isModuleCommandName(name: string): boolean {
  return MODULE_COMMAND_NAME.test(name) && !name.startsWith(RESERVED_COMMAND_PREFIX);
}

/** Where a program in the VM runs a module command: names only, so every stub lives in this one directory. */
export function moduleCommandPath<N extends string>(name: N): `/usr/local/bin/${N}` {
  return `/usr/local/bin/${name}`;
}
