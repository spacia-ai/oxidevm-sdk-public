// Whether a module is the program Node was started on, so a script can be imported (by its tests) without running.
// `import.meta.main` would do, but it needs Node 24.2 and is undefined before: the script would silently do nothing.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when Node runs the module at `moduleUrl` (pass `import.meta.url`) as its entry point, symlinks resolved. */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}
