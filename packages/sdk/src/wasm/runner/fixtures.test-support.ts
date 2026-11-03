import type { CommandDecl, ResolvedManifest, ServiceDecl } from "../manifest-types.js";
import { decodeResolvedManifest } from "../manifest.js";
import type { LaunchDescriptor } from "./descriptor.js";

export const BASE_URL = "https://app.test/modules/";
const encoder = new TextEncoder();

export async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A declaration before its artifacts are hashed. */
export type PinlessDeclaration = Omit<CommandDecl, "artifacts"> | Omit<ServiceDecl, "artifacts">;

export interface ReleaseSpec {
  /** The ES module source of the adapter bundle: `export default host => hooks`. */
  readonly adapter: string;
  readonly artifacts?: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
  /** Everything of the manifest except the pins: id, version, abi, process, requires, license and optional parts. */
  readonly declaration: PinlessDeclaration;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly workspaceId?: string;
  /** Replaces the served bytes of a file after hashing, to model tampering. */
  readonly tamper?: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
}

export interface Release {
  readonly manifest: ResolvedManifest;
  readonly descriptor: LaunchDescriptor;
  /** What the fake server answers, by URL. */
  readonly served: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

/** Hashes real bytes into a manifest, pins and served-file table, the way `oxidevm wasm build` and `stage` will. */
export async function buildRelease(spec: ReleaseSpec): Promise<Release> {
  const adapterBytes = encoder.encode(spec.adapter);
  const artifacts = spec.artifacts ?? {};
  const pins = await Promise.all(Object.entries(artifacts).map(async ([name, bytes]) => ({ name, sha256: await digest(bytes), bytes: bytes.length })));
  const adapterSha = await digest(adapterBytes);
  const manifest = decodeResolvedManifest({ schemaVersion: 1, ...spec.declaration, adapter: { api: 1, sha256: adapterSha, bytes: adapterBytes.length }, artifacts: pins });
  const served = new Map<string, Uint8Array<ArrayBuffer>>([[`${BASE_URL}adapter.mjs`, spec.tamper?.["adapter.mjs"] ?? adapterBytes]]);
  for (const [name, bytes] of Object.entries(artifacts)) served.set(`${BASE_URL}${name}`, spec.tamper?.[name] ?? bytes);
  const descriptor: LaunchDescriptor = {
    v: 1,
    manifest,
    release: await digest(encoder.encode(`${adapterSha}\n${pins.map(pin => pin.sha256).join("\n")}\n`)),
    adapter: { url: `${BASE_URL}adapter.mjs`, sha256: adapterSha, bytes: adapterBytes.length },
    artifacts: Object.fromEntries(pins.map(pin => [pin.name, { url: `${BASE_URL}${pin.name}`, sha256: pin.sha256, bytes: pin.bytes }])),
    options: spec.options ?? {},
    ...(spec.workspaceId === undefined ? {} : { workspaceId: spec.workspaceId }),
  };
  return { manifest, descriptor, served };
}

export const COMMAND_DECLARATION = {
  id: "tool", version: "1.0.0", abi: "bindgen", process: { kind: "command" },
  requires: { host: ["files.sync"] }, license: { spdx: "MIT" },
} as const satisfies PinlessDeclaration;

export const SERVICE_DECLARATION = {
  id: "db", version: "1.0.0", abi: "emscripten", process: { kind: "service", exclusive: "workspace" },
  expose: { sql: { kind: "unix", path: "/workspace/_oxidevm/db.sock", protocol: "db-sql/1" }, pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" } },
  requires: { host: ["files.sync"] }, license: { spdx: "Apache-2.0" },
} as const satisfies PinlessDeclaration;
