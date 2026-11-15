import { VMError } from "@oxvm/sdk";

type Setting = "SIGNING_KEY_FILE" | "IMAGE_TRUST_FILE" | "SNAPSHOT_TRUST_FILE";

/** Flags override this fallback; conflicting environment aliases never select a key silently. */
export function setting(environment: Readonly<Record<string, string | undefined>>, name: Setting): string | undefined {
  const canonical = `OXVM_${name}`, legacy = `OXIDEVM_${name}`;
  const current = environment[canonical], previous = environment[legacy];
  if (current !== undefined && previous !== undefined && current !== previous) throw new VMError("INVALID_ARGUMENT", `${canonical} and ${legacy} differ; set one value or use the explicit flag`);
  return current ?? previous;
}
