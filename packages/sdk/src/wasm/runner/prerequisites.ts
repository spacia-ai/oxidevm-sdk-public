import type { LinuxFiles } from "../../js-process-types.js";
import { linuxErrno } from "../kit/errno.js";
import type { BrowserFeature } from "../capabilities.js";
import type { ResolvedManifest } from "../manifest-types.js";

/** What this browser context offers; the entry point reads it from globals, tests pass a literal. */
export interface BrowserProbe {
  readonly crossOriginIsolated: boolean;
  readonly indexedDB: boolean;
  readonly jspi: boolean;
  readonly webLocks: boolean;
}

const PROBE_KEYS = {
  "cross-origin-isolated": "crossOriginIsolated",
  indexeddb: "indexedDB",
  jspi: "jspi",
  "web-locks": "webLocks",
} as const satisfies Record<BrowserFeature, keyof BrowserProbe>;

const S_IFMT = 0o170000, S_IFREG = 0o100000, ANY_EXECUTE = 0o111, ENOENT = 2;

/** Names every browser feature and guest executable the manifest requires and this context lacks. */
export async function missingPrerequisites(manifest: ResolvedManifest, probe: BrowserProbe, files: Pick<LinuxFiles, "stat">): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const feature of manifest.requires.browser ?? []) if (!probe[PROBE_KEYS[feature]]) missing.push(`browser feature ${feature}`);
  for (const path of manifest.requires.guest?.executables ?? []) {
    try {
      const { mode } = await files.stat(path);
      if ((mode & S_IFMT) !== S_IFREG || (mode & ANY_EXECUTE) === 0) missing.push(`guest executable ${path} (not an executable file)`);
    } catch (error: unknown) {
      if (linuxErrno(error) !== ENOENT) throw error;
      missing.push(`guest executable ${path}`);
    }
  }
  return missing;
}
