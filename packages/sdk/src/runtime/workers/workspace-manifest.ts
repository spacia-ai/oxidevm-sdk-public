import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeWorkspaceStream, type WorkspaceStreamRef } from "./workspace-stream.js";

export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const FORMAT_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface LegacyWorkspaceManifest {
  readonly formatVersion: 1;
  readonly generation: number;
  readonly workspaceBaseSha256: string;
  readonly snapshotSha256?: string;
  readonly snapshotBytes?: number;
  readonly deltaSha256?: string;
  readonly deltaBytes?: number;
}

interface DependencyManifest {
  readonly generation: string;
  readonly inputsSha256: string;
  readonly tree: WorkspaceStreamRef;
}

export interface StreamWorkspaceManifest {
  readonly formatVersion: 2;
  readonly generation: number;
  readonly workspaceBaseSha256: string;
  readonly snapshot: WorkspaceStreamRef;
  readonly delta: WorkspaceStreamRef;
  readonly dependencies?: DependencyManifest;
}
export type WorkspaceOverlayManifest = LegacyWorkspaceManifest | StreamWorkspaceManifest;


export function decodeWorkspaceOverlayManifest(value: unknown): WorkspaceOverlayManifest {
  const manifest = record(value, "workspace overlay manifest");
  if (manifest["formatVersion"] === 2) {
    exactKeys(manifest, ["formatVersion", "generation", "workspaceBaseSha256", "snapshot", "delta"], ["dependencies"]);
    return { formatVersion: 2, generation: integer(manifest["generation"], "workspace overlay generation", 1),
      workspaceBaseSha256: digest(manifest["workspaceBaseSha256"], "workspace base SHA-256"),
      snapshot: decodeWorkspaceStream(manifest["snapshot"]), delta: decodeWorkspaceStream(manifest["delta"]),
      ...(manifest["dependencies"] === undefined ? {} : { dependencies: decodeDependencies(manifest["dependencies"]) }) };
  }
  exactKeys(manifest, [
    "formatVersion",
    "generation",
    "workspaceBaseSha256",
  ], ["snapshotSha256", "snapshotBytes", "deltaSha256", "deltaBytes"]);
  if (integer(manifest["formatVersion"], "workspace overlay format") !== FORMAT_VERSION) {
    throw new VMError("STORAGE_ERROR", "workspace overlay format is unsupported");
  }
  const snapshot = manifest["snapshotSha256"] === undefined && manifest["snapshotBytes"] === undefined
    ? {}
    : {
        snapshotSha256: digest(manifest["snapshotSha256"], "workspace snapshot SHA-256"),
        snapshotBytes: integer(manifest["snapshotBytes"], "workspace snapshot bytes", 0, MAX_SNAPSHOT_BYTES),
      };
  const delta = manifest["deltaSha256"] === undefined && manifest["deltaBytes"] === undefined
    ? {}
    : {
        deltaSha256: digest(manifest["deltaSha256"], "workspace delta SHA-256"),
        deltaBytes: integer(manifest["deltaBytes"], "workspace delta bytes", 0, MAX_SNAPSHOT_BYTES),
      };
  if (Object.keys(snapshot).length === 0 && Object.keys(delta).length === 0) {
    throw new VMError("STORAGE_ERROR", "workspace overlay contains no data");
  }
  return {
    formatVersion: FORMAT_VERSION,
    generation: integer(manifest["generation"], "workspace overlay generation", 1),
    workspaceBaseSha256: digest(manifest["workspaceBaseSha256"], "workspace base SHA-256"),
    ...snapshot,
    ...delta,
  };
}

export function digest(value: unknown, name: string): string {
  const result = string(value, name);
  if (!SHA256.test(result)) throw new VMError("STORAGE_ERROR", `${name} is invalid`);
  return result;
}

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new VMError("STORAGE_ERROR", "workspace overlay metadata is not valid UTF-8 JSON");
  }
}

export function encodeJson(value: WorkspaceOverlayManifest): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value));
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function streamReferences(manifest: StreamWorkspaceManifest): readonly WorkspaceStreamRef[] {
  return [manifest.snapshot, manifest.delta, ...(manifest.dependencies === undefined ? [] : [manifest.dependencies.tree])];
}

/** The references `previous` names that `next` does not carry over. Identity decides: a reference that `next`
 * reuses stays live, while an equal copy held by another object counts as dropped and recovery filters it. */
export function droppedStreamReferences(previous: StreamWorkspaceManifest,
  next: StreamWorkspaceManifest): readonly WorkspaceStreamRef[] {
  const carried = streamReferences(next);
  return streamReferences(previous).filter(reference => !carried.includes(reference));
}

function decodeDependencies(value: unknown): DependencyManifest {
  const input = record(value, "dependency manifest");
  exactKeys(input, ["generation", "inputsSha256", "tree"]);
  return { generation: digest(input["generation"], "dependency generation"),
    inputsSha256: digest(input["inputsSha256"], "dependency inputs SHA-256"), tree: decodeWorkspaceStream(input["tree"]) };
}

export function dependencyHash(inputsSha256: string, tree: WorkspaceStreamRef): Promise<string> {
  return sha256(new TextEncoder().encode(JSON.stringify({ formatVersion: 1, inputsSha256, tree })));
}

export async function verifyDependencies(manifest: StreamWorkspaceManifest): Promise<void> {
  const value = manifest.dependencies;
  if (value !== undefined && await dependencyHash(value.inputsSha256, value.tree) !== value.generation) {
    throw new VMError("STORAGE_ERROR", "Dependency manifest identity does not match its contents");
  }
}
