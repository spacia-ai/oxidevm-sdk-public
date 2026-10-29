import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Shared by release controllers and the trusted public publication bootstrap. */
export function assertReleaseVersionActive(version: string): void {
  const policy: unknown = JSON.parse(readFileSync(new URL("../config/release-policy.json", import.meta.url), "utf8"));
  assert(typeof policy === "object" && policy !== null && !Array.isArray(policy) && Object.keys(policy).length === 2 && "schemaVersion" in policy && policy.schemaVersion === 1 && "retiredVersions" in policy && Array.isArray(policy.retiredVersions) && policy.retiredVersions.length <= 64, "Invalid release version policy");
  const retired = Array.from<unknown>(policy.retiredVersions).map(value => {
    assert(typeof value === "string" && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value), "Invalid retired version"); return value;
  });
  assert(new Set(retired).size === retired.length, "Duplicate retired version");
  if (retired.includes(version)) throw new Error(`SDK ${version} is permanently retired. Use an active release version.`);
}
