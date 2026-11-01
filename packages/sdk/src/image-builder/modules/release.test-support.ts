import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeResolvedManifest, encodeModuleManifest } from "../../wasm/manifest.js";
import type { ResolvedManifest } from "../../wasm/manifest-types.js";
import { formatSums } from "./sums.js";

export const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

export interface BuiltRelease {
  readonly manifest: ResolvedManifest;
  readonly manifestBytes: Uint8Array<ArrayBuffer>;
  readonly sumsBytes: Uint8Array<ArrayBuffer>;
  /** Every file of the release by name, including `module.json` and `SHA256SUMS`. */
  readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

export interface ReleaseSpec {
  readonly id?: string;
  readonly version?: string;
  readonly adapter?: string;
  readonly artifacts?: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
  readonly host?: readonly string[];
  /** Extra declaration fields, merged over the defaults. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** A complete, consistent release, hashed the way `oxidevm wasm build` will. */
export function buildReleaseFiles(spec: ReleaseSpec = {}): BuiltRelease {
  const adapter = encoder.encode(spec.adapter ?? "export default () => ({ main: () => 0 });");
  const artifacts = spec.artifacts ?? { "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0) };
  const manifest = decodeResolvedManifest({
    schemaVersion: 1, id: spec.id ?? "tool", version: spec.version ?? "1.0.0", abi: "raw",
    adapter: { api: 1, sha256: sha(adapter), bytes: adapter.byteLength },
    artifacts: Object.entries(artifacts).map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.byteLength })),
    process: { kind: "command" }, requires: { host: spec.host ?? ["files.sync"] }, license: { spdx: "MIT" }, ...spec.extra,
  });
  const manifestBytes = encodeModuleManifest(manifest);
  const files = new Map<string, Uint8Array<ArrayBuffer>>([["module.json", manifestBytes], ["adapter.mjs", adapter], ...Object.entries(artifacts)]);
  const sumsBytes = formatSums([...files].map(([name, bytes]) => ({ name, sha256: sha(bytes) })));
  files.set("SHA256SUMS", sumsBytes);
  return { manifest, manifestBytes, sumsBytes, files };
}

export async function writeReleaseDirectory(directory: string, release: BuiltRelease): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of release.files) await writeFile(join(directory, name), bytes);
}
