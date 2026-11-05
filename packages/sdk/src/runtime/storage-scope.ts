import { VMError } from "./errors.ts";

// Whose OxideVM storage a VM uses in its browser storage partition, and the names that guard it.
//
// A self-hosted page's VMs use its own origin's storage, which the browser keeps apart from every
// other origin. The runtime frame (ADR 0021) serves every page that embeds it from one origin, and
// browsers partition the frame's storage by the embedding page's top-level site, not by its origin:
// pages on one site (app.example.com and docs.example.com, two localhost ports, the demos on
// *.oxidevm.dev) would share one store, its workspace locks and its handoff channels. The frame
// therefore gives each embedding origin a scope of its own. Every OPFS directory, IndexedDB
// database, Web Lock and BroadcastChannel name the SDK uses for VM storage comes from here.

/** This origin's own OxideVM storage, or the part of the runtime frame's storage that belongs to one embedding origin. */
export type StorageScope =
  | { readonly kind: "origin" }
  | { readonly kind: "embedder"; readonly id: string };

export const ORIGIN_STORAGE: StorageScope = { kind: "origin" };

const ORIGIN_PREFIX = "oxidevm-";
/** No origin-scope name starts with this: every name an origin scope builds starts with a fixed word such as `workspace-`. */
const EMBEDDER_PREFIX = "oxidevm-embedder-";
const EMBEDDER_ID = /^[0-9a-f]{32}$/u;

/** The scope of the page at `origin` inside the runtime frame: the first 128 bits of the SHA-256 of that origin. */
export async function embedderStorage(origin: string): Promise<StorageScope> {
  let serialized: string;
  try { serialized = new URL(origin).origin; }
  catch { throw new VMError("PROTOCOL_ERROR", "embedder origin is invalid"); }
  if (serialized === "null" || serialized !== origin) throw new VMError("PROTOCOL_ERROR", "embedder origin is invalid");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)));
  return { kind: "embedder", id: Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("") };
}

export function sameStorageScope(left: StorageScope, right: StorageScope): boolean {
  return left.kind === "origin" ? right.kind === "origin" : right.kind === "embedder" && right.id === left.id;
}

/** The OPFS directory, under the partition's root, that holds everything of the scope. */
export function storageDirectoryName(scope: StorageScope): string {
  return scope.kind === "origin" ? "oxidevm" : `${EMBEDDER_PREFIX}${scope.id}`;
}

/** The scope's IndexedDB database, Web Lock or BroadcastChannel called `name`. */
export function storageName(scope: StorageScope, name: string): string {
  return scope.kind === "origin" ? `${ORIGIN_PREFIX}${name}` : `${EMBEDDER_PREFIX}${scope.id}-${name}`;
}

/** Whether a database or lock name belongs to the scope; an origin's own names exclude every embedder's. */
export function inStorageScope(scope: StorageScope, name: string): boolean {
  return scope.kind === "origin"
    ? name.startsWith(ORIGIN_PREFIX) && !name.startsWith(EMBEDDER_PREFIX)
    : name.startsWith(`${EMBEDDER_PREFIX}${scope.id}-`);
}

/** The scope as an optional storage worker request field; the origin's own storage sends none. */
export function encodeStorageScope(scope: StorageScope): { readonly storage?: string } {
  return scope.kind === "origin" ? {} : { storage: scope.id };
}

export function decodeStorageScope(value: unknown): StorageScope {
  if (value === undefined) return ORIGIN_STORAGE;
  if (typeof value !== "string" || !EMBEDDER_ID.test(value)) throw new VMError("PROTOCOL_ERROR", "storage scope is invalid");
  return { kind: "embedder", id: value };
}
