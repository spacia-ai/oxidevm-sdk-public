import { VMError } from "../../errors.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGES = 65_536;
/** A `packages:` entry key: `name@version` or `'@scope/name@version'`, where
 * the version carries no `:` (registry versions only; `file:`, `link:` and
 * tarball URL specifiers stay out of the set and are served verbatim). */
const ENTRY = /^ {2}(?:'((?:@[^'/@\s]+\/)?[^'/@\s]+)@([^':\s]+)':|((?:@[^'/@\s]+\/)?[^'/@\s]+)@([^':\s]+):)\s*$/u;

/** The registry versions a frozen pnpm install can consult, read from the
 * lockfile's `packages:` section: every `name@version` key by package name.
 * The `snapshots:` section (peer-suffixed keys) is not consulted. */
export function lockedPackageVersions(lockfile: string): Readonly<Record<string, readonly string[]>> {
  if (lockfile.length > MAX_BYTES) throw new VMError("QUOTA_EXCEEDED", "pnpm lockfile exceeds its bound");
  const versions = new Map<string, string[]>();
  let inPackages = false;
  let count = 0;
  for (const line of lockfile.split("\n")) {
    if (line.length === 0) continue;
    if (line[0] !== " ") { inPackages = line === "packages:"; continue; }
    if (!inPackages) continue;
    const match = ENTRY.exec(line);
    if (match === null) continue;
    const name = match[1] ?? match[3];
    const version = match[2] ?? match[4];
    if (name === undefined || version === undefined) continue;
    count += 1;
    if (count > MAX_PACKAGES) throw new VMError("QUOTA_EXCEEDED", "pnpm lockfile packages exceed their bound");
    const known = versions.get(name);
    if (known === undefined) versions.set(name, [version]);
    else known.push(version);
  }
  return Object.fromEntries(versions);
}
