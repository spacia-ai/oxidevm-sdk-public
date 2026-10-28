import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The four modules of an engine release, in release.json order, with the mode each serves. */
const MODULES = [
  { name: "oxidevm_core.wasm", mode: "system" },
  { name: "oxidevm_core_shared.wasm", mode: "system" },
  { name: "oxidevm_netstack.wasm", mode: "system" },
  { name: "oxidevm_userspace.wasm", mode: "userspace" },
] as const;

export interface SyntheticEngineRelease {
  /** SHA-256 of `releaseJson`, as the engine names a release. */
  readonly id: string;
  readonly manifest: {
    readonly schemaVersion: 3;
    readonly engineSource: { readonly commit: string; readonly dirty: boolean; readonly nativeInputsSHA256: string };
    readonly identities: { readonly coreApi: number; readonly jitAbi: number; readonly userspaceApi: number; readonly netstackApi: number };
    readonly artifacts: readonly { readonly name: (typeof MODULES)[number]["name"]; readonly mode: (typeof MODULES)[number]["mode"]; readonly bytes: number; readonly sha256: string }[];
  };
  readonly releaseJson: Uint8Array;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly license: string;
  /** What a pin records for `license`: it is not part of release.json, so the pin carries it separately. */
  readonly licenseIdentity: { readonly bytes: number; readonly sha256: string };
}
type Identities = SyntheticEngineRelease["manifest"]["identities"];

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** An empty but valid WebAssembly module whose one custom section makes its bytes unique. */
function standInModule(variant: number, index: number): Uint8Array {
  const name = new TextEncoder().encode("oxidevm-test");
  const section = [name.length, ...name, variant, index];
  return Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, section.length, ...section);
}

/**
 * A schema-3 release laid out the way the engine's release builder writes one, with tiny valid
 * stand-in modules. A different `variant` changes every module and therefore the release ID.
 */
export function syntheticEngineRelease(variant = 0, identities: Identities = { coreApi: 16, jitAbi: 59, userspaceApi: 29, netstackApi: 2 }): SyntheticEngineRelease {
  const entries = MODULES.map(({ name, mode }, index) => ({ name, mode, bytes: standInModule(variant, index) }));
  const manifest = {
    schemaVersion: 3 as const,
    engineSource: { commit: "c".repeat(40), dirty: false, nativeInputsSHA256: "d".repeat(64) },
    identities: { coreApi: identities.coreApi, jitAbi: identities.jitAbi, userspaceApi: identities.userspaceApi, netstackApi: identities.netstackApi },
    artifacts: entries.map(({ name, mode, bytes }) => ({ name, mode, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  const releaseJson = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const license = "Synthetic engine terms for tests.\n";
  const licenseBytes = new TextEncoder().encode(license);
  return {
    id: sha256(releaseJson), manifest, releaseJson,
    modules: new Map(entries.map(({ name, bytes }) => [name, bytes])),
    license, licenseIdentity: { bytes: licenseBytes.length, sha256: sha256(licenseBytes) },
  };
}

/** Writes the release directory: release.json, LICENSE and the four modules. */
export async function writeSyntheticRelease(directory: string, release: SyntheticEngineRelease): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "release.json"), release.releaseJson);
  await writeFile(join(directory, "LICENSE"), release.license);
  for (const [name, bytes] of release.modules) await writeFile(join(directory, name), bytes);
}

/** What `pnpm engine:pin --local-only` would generate for this release, for mocking `engine.generated.js`. */
export function syntheticGeneratedPin(release: SyntheticEngineRelease): {
  readonly engineReleaseId: string;
  readonly engineRelease: SyntheticEngineRelease["manifest"];
  readonly engineLicense: SyntheticEngineRelease["licenseIdentity"];
  readonly engineDownload: null;
  readonly engineCompliance: null;
} {
  return { engineReleaseId: release.id, engineRelease: release.manifest, engineLicense: release.licenseIdentity, engineDownload: null, engineCompliance: null };
}
