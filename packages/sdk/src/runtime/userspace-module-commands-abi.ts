import { integer } from "./decode.ts";
import { protocol, Reader, Writer } from "./js-process/codec.ts";
import { isModuleCommandName } from "./module-command-names.ts";

/**
 * A VM's module-command table (engine ADR 0027, Userspace API 145). The page sends the whole table to
 * `oxidevm_userspace_module_commands_apply` as OXMC v1 and Rust answers OXMA v1; Rust owns the stubs at
 * `/usr/local/bin/<name>` and validates the table again.
 */

/** The most names one VM's table holds. */
export const MODULE_COMMAND_MAX_NAMES = 64;
/** The largest per-registration concurrency, the size of Rust's host command table. */
export const MODULE_COMMAND_MAX_CONCURRENCY = 32;

/** One name of the table, owned by `registration`, which runs at most `concurrency` commands at once. */
export interface ModuleCommandEntry { readonly registration: number; readonly concurrency: number; readonly name: string }

/**
 * OXMC v1: "OXMC", u32 1, u32 count, count x (u32 registration, u32 concurrency, u32 name length, name), all
 * little-endian, in the given order. A table Rust would refuse is refused here before anything is written: the
 * SDK computes the table, so a refusal is a defect of the caller, not an engine answer.
 */
export function encodeModuleCommandTable(entries: readonly ModuleCommandEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length > MODULE_COMMAND_MAX_NAMES) protocol("Module command table exceeds its name limit");
  const names = new Set<string>(), limits = new Map<number, number>();
  const writer = new Writer().raw(new TextEncoder().encode("OXMC")).u32(1).u32(entries.length);
  for (const entry of entries) {
    const registration = integer(entry.registration, "module command registration", 1, 0xffff_ffff);
    const concurrency = integer(entry.concurrency, "module command concurrency", 1, MODULE_COMMAND_MAX_CONCURRENCY);
    if (!isModuleCommandName(entry.name)) protocol("Invalid module command name");
    if (names.has(entry.name)) protocol("Duplicate module command name");
    if ((limits.get(registration) ?? concurrency) !== concurrency) protocol("A module command registration has one concurrency limit");
    names.add(entry.name); limits.set(registration, concurrency);
    writer.u32(registration).u32(concurrency).blob(new TextEncoder().encode(entry.name));
  }
  return writer.finish();
}

/** Why an applied table left one of its names without a stub: another file holds the path, and it is kept. */
export interface ModuleCommandSkip { readonly entry: number; readonly reason: "occupied" }

/** What one application did. `entry` indexes the request; `changed` says whether `/usr/local/bin` changed. */
export type ModuleCommandApplication =
  | { readonly outcome: "applied"; readonly changed: boolean; readonly skipped: readonly ModuleCommandSkip[] }
  | { readonly outcome: "malformed" | "invalid-name" | "duplicate" | "too-many"; readonly entry: number | null }
  | { readonly outcome: "directory-unavailable" | "busy" | "initial-user-root" }
  | { readonly outcome: "filesystem"; readonly changed: boolean; readonly entry: number | null; readonly errno: number };

/** OXMA v1 outcome codes; code 5 is unused. */
const OUTCOMES: ReadonlyMap<number, ModuleCommandApplication["outcome"]> = new Map([
  [0, "applied"], [1, "malformed"], [2, "invalid-name"], [3, "duplicate"], [4, "too-many"],
  [6, "directory-unavailable"], [7, "busy"], [8, "initial-user-root"], [9, "filesystem"],
] as const);
const NO_ENTRY = 0xffff_ffff;

/**
 * OXMA v1: "OXMA", u32 1, u8 outcome, u8 changed, u32 entry (0xffffffff for none), u32 errno (0 for none), u32
 * skipped count, then per skipped entry u32 index and u8 reason 1 (occupied). `requested` is the number of entries
 * of the OXMC request it answers, which bounds every index.
 */
export function decodeModuleCommandApplication(bytes: Uint8Array, requested: number): ModuleCommandApplication {
  integer(requested, "module command request size", 0, 0xffff_ffff);
  const r = new Reader(bytes);
  if (new TextDecoder().decode(r.raw(4)) !== "OXMA" || r.u32() !== 1) protocol("Module command application version mismatch");
  const outcome = OUTCOMES.get(r.u8()), changedCode = r.u8(), entryCode = r.u32(), errno = r.u32();
  const skipped = Array.from({ length: integer(r.u32(), "skipped module commands", 0, Math.min(requested, MODULE_COMMAND_MAX_NAMES)) }, (): ModuleCommandSkip => {
    const entry = r.u32(); if (r.u8() !== 1) protocol("Unknown module command skip reason");
    return { entry, reason: "occupied" };
  });
  r.end();
  if (outcome === undefined || changedCode > 1) protocol("Invalid module command application");
  const changed = changedCode === 1, entry = entryCode === NO_ENTRY ? null : entryCode;
  if (entry !== null && entry >= requested || errno > 4095 || (errno !== 0) !== (outcome === "filesystem")) protocol("Invalid module command fault");
  if (skipped.some((skip, index) => skip.entry >= requested || index > 0 && skip.entry <= (skipped[index - 1]?.entry ?? NO_ENTRY))) protocol("Invalid skipped module command");
  if (outcome !== "applied" && skipped.length > 0 || changed && outcome !== "applied" && outcome !== "filesystem") protocol("Refused module command table reports effects");
  switch (outcome) {
    case "applied": if (entry !== null) protocol("Applied module command table names a fault"); return { outcome, changed, skipped };
    case "malformed": return { outcome, entry };
    case "invalid-name": case "duplicate": if (entry === null) protocol("Module command refusal names no entry"); return { outcome, entry };
    case "too-many": if (entry !== MODULE_COMMAND_MAX_NAMES || requested <= MODULE_COMMAND_MAX_NAMES) protocol("Invalid module command limit refusal"); return { outcome, entry };
    case "directory-unavailable": case "busy": case "initial-user-root": if (entry !== null) protocol("Module command refusal names an entry"); return { outcome };
    case "filesystem": return { outcome, changed, entry, errno };
  }
}
