import { CAPABILITY_MIN_API } from "../../wasm/capabilities.js";
import { formatModuleSource, type ModuleSource } from "../../wasm/declaration.js";
import { classifyLicense } from "../../wasm/license.js";
import type { Tristate } from "../../wasm/lock.js";
import type { ResolvedManifest } from "../../wasm/manifest-types.js";
import { isServiceDecl } from "../../wasm/manifest.js";
import type { Resolution } from "./resolve.js";

/** Everything the person adding a module is asked to accept, taken from `module.json` and never from prose. */
export interface ConsentCard {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly release: string;
  readonly license: { readonly spdx: string; readonly copyleft: boolean; readonly source?: string };
  readonly capabilities: readonly string[];
  readonly browser: readonly string[];
  readonly guestExecutables: readonly string[];
  readonly mounts: readonly string[];
  readonly endpoints: readonly string[];
  readonly guestFiles: readonly string[];
  readonly durablePaths: readonly string[];
  readonly options: readonly string[];
  readonly artifacts: readonly { readonly name: string; readonly bytes: number }[];
  readonly signals: { readonly commit?: string; readonly immutable?: Tristate; readonly attested?: Tristate };
  /** The first Userspace API version that serves every operation the module asks for. */
  readonly minApi: number;
}

/**
 * The authority a manifest asks for, as sorted strings. Two releases are compared by this list: a release that asks for
 * a string the installed one did not needs the person's consent again, however much the source is trusted.
 */
export function authorityOf(manifest: ResolvedManifest): readonly string[] {
  const authority = [
    ...manifest.requires.host.map(capability => `host:${capability}`),
    ...(manifest.requires.browser ?? []).map(feature => `browser:${feature}`),
    ...(manifest.requires.guest?.executables ?? []).map(path => `guest-executable:${path}`),
    ...(manifest.mounts ?? []).map(mount => `mount:${mount.access}:${mount.guest}`),
    ...(isServiceDecl(manifest) ? Object.values(manifest.expose).map(endpoint => endpoint.kind === "unix" ? `listen:unix:${endpoint.path}` : `listen:tcp:${String(endpoint.port)}`) : []),
    ...(manifest.guestFiles ?? []).map(file => `guest-file:${file.to}`),
    ...(manifest.state?.durable ?? []).map(path => `durable:${path}`),
  ];
  return [...new Set(authority)].sort();
}

/** What a new release asks for that the installed one did not, and what it no longer asks for. */
export function authorityChange(previous: ResolvedManifest | undefined, next: ResolvedManifest): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const before = new Set(previous === undefined ? [] : authorityOf(previous)), after = new Set(authorityOf(next));
  return { added: [...after].filter(item => !before.has(item)), removed: [...before].filter(item => !after.has(item)) };
}

export function consentCard(resolution: Resolution, source: ModuleSource): ConsentCard {
  const { manifest } = resolution.release;
  const { source: locked } = resolution;
  const signals = locked.kind === "github" ? { commit: locked.commit, immutable: locked.immutable, attested: locked.attested } : {};
  return {
    id: manifest.id,
    version: manifest.version,
    source: formatModuleSource(source),
    release: resolution.release.id,
    license: { spdx: manifest.license.spdx, copyleft: classifyLicense(manifest.license.spdx).copyleft, ...(manifest.license.source === undefined ? {} : { source: manifest.license.source }) },
    capabilities: manifest.requires.host,
    browser: manifest.requires.browser ?? [],
    guestExecutables: manifest.requires.guest?.executables ?? [],
    mounts: (manifest.mounts ?? []).map(mount => `${mount.access} ${mount.guest}`),
    endpoints: isServiceDecl(manifest) ? Object.entries(manifest.expose).map(([name, endpoint]) => `${name}: ${endpoint.kind === "unix" ? endpoint.path : `127.0.0.1:${String(endpoint.port)}`} (${endpoint.protocol})`) : [],
    guestFiles: (manifest.guestFiles ?? []).map(file => file.to),
    durablePaths: manifest.state?.durable ?? [],
    options: Object.keys(manifest.options ?? {}),
    artifacts: manifest.artifacts.map(artifact => ({ name: artifact.name, bytes: artifact.bytes })),
    signals,
    minApi: Math.max(0, ...manifest.requires.host.map(capability => CAPABILITY_MIN_API[capability])),
  };
}
