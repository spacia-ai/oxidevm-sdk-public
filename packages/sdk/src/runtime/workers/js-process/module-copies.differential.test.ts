import { describe, expect, it } from "vitest";
import { Random } from "../../fuzz.test-support.js";
import { VMError } from "../../errors.js";
import { copyKey, type CopyKey } from "../../protocol/userspace-module-files.js";
import { digest } from "../../../wasm/runner/fixtures.test-support.js";
import { verifyPinned } from "../../../wasm/runner/pinned.js";
import type { Pin } from "../../../wasm/handle.js";
import { ModuleCopies, type CopyHolder, type CopyRequest } from "./module-copies.js";

// Differential evidence for integrity (engine ADR 0028, plan SL-I12): the VM's verified-copy store checks each file once
// per VM (verify-once) where 0.0.9 fetched and checked every file on every start (per-start). For the same seeded
// schedule of starts, releases and server states (a file served intact, altered, truncated, padded or not at all), both
// must deliver only pinned bytes; verify-once accepts whatever per-start accepts; it refuses an integrity failure only
// where per-start refuses one for the same file; and it differs from per-start only by not reading a file it already
// holds, which is the decision of ADR 0028.

const SEEDS = 24, STEPS = 60, FILES = 5;
type Served = "intact" | "altered" | "short" | "long" | "unreachable";
type Outcome = { readonly ok: true; readonly delivered: ReadonlyMap<string, Uint8Array> } | { readonly ok: false; readonly file: string; readonly reason: string };

interface File { readonly request: CopyRequest; readonly bytes: Uint8Array<ArrayBuffer> }

function served(file: File, state: Served): Uint8Array<ArrayBuffer> | undefined {
  switch (state) {
    case "intact": return file.bytes;
    case "altered": { const copy = Uint8Array.from(file.bytes); copy[0] = (copy[0] ?? 0) ^ 1; return copy; }
    case "short": return file.bytes.slice(0, -1);
    case "long": return Uint8Array.of(...file.bytes, 0);
    case "unreachable": return undefined;
  }
}

/** 0.0.9: every start fetches every file it needs and checks it against its pin. */
async function perStart(files: readonly File[], states: readonly Served[]): Promise<Outcome> {
  const delivered = new Map<string, Uint8Array>();
  for (const [index, file] of files.entries()) {
    const bytes = served(file, states[index] ?? "intact");
    if (bytes === undefined) return { ok: false, file: file.request.file, reason: "fetch" };
    try { await verifyPinned(bytes, file.request.pin, file.request.file, file.request.file); }
    catch (error: unknown) { return { ok: false, file: file.request.file, reason: error instanceof VMError ? String(error.detail?.["reason"]) : "other" }; }
    delivered.set(file.request.file, bytes);
  }
  return { ok: true, delivered };
}

/** ADR 0028: the page reads only what the store lacks, and the store checks those once. */
async function verifyOnce(store: ModuleCopies, holder: CopyHolder, files: readonly File[], states: readonly Served[]): Promise<Outcome> {
  const missing = new Set<CopyKey>(store.missing(files.map(file => file.request.pin)));
  const supplied = new Map<string, Blob>();
  for (const [index, file] of files.entries()) {
    const key = copyKey(file.request.pin);
    if (!missing.has(key) || supplied.has(key)) continue;
    const bytes = served(file, states[index] ?? "intact");
    if (bytes === undefined) return { ok: false, file: file.request.file, reason: "fetch" };
    supplied.set(key, new Blob([bytes]));
  }
  try {
    const copies = await store.hold(holder, files.map(file => file.request), supplied, new AbortController().signal);
    const delivered = new Map<string, Uint8Array>();
    for (const file of files) delivered.set(file.request.file, new Uint8Array(await (copies.get(copyKey(file.request.pin)) ?? new Blob()).arrayBuffer()));
    return { ok: true, delivered };
  } catch (error: unknown) {
    if (!(error instanceof VMError)) throw error;
    return { ok: false, file: String(error.detail?.["file"]), reason: `${error.code} ${String(error.detail?.["reason"])} ${error.message}` };
  }
}

async function makeFiles(random: Random): Promise<File[]> {
  return Promise.all(Array.from({ length: FILES }, async (_, index) => {
    const bytes = random.bytes(1 + random.below(64));
    const pin: Pin = { sha256: await digest(bytes), bytes: bytes.byteLength };
    return { request: { file: index === 0 ? "adapter.mjs" : `artifact-${String(index)}.wasm`, pin }, bytes };
  }));
}

describe("verify-once copies against per-start checks (ADR 0028)", () => {
  it(`deliver only pinned bytes and differ only on files the VM already holds (${String(SEEDS)} seeds x ${String(STEPS)} steps)`, async () => {
    const tally = { agreed: 0, heldNotReread: 0, refusedBoth: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = new Random(seed), files = await makeFiles(random), store = new ModuleCopies();
      for (let step = 0; step < STEPS; step++) {
        if (random.chance(0.15)) { store.release({ kind: "registration", id: 1 + random.below(3) }); continue; }
        const chosen = files.filter(() => random.chance(0.6));
        if (chosen.length === 0) continue;
        const states = chosen.map((): Served => random.chance(0.7) ? "intact" : random.pick(["altered", "short", "long", "unreachable"] as const));
        const holder: CopyHolder = random.chance(0.4) ? { kind: "spawn" } : { kind: "registration", id: 1 + random.below(3) };
        const held = new Set(chosen.filter(file => store.missing([file.request.pin]).length === 0).map(file => file.request.file));
        const once = await verifyOnce(store, holder, chosen, states), every = await perStart(chosen, states);
        const where = `seed ${String(seed)} step ${String(step)}`;
        if (once.ok) for (const file of chosen) expect(once.delivered.get(file.request.file), where).toEqual(file.bytes);
        if (every.ok) {
          expect(once.ok, `${where}: per-start accepted, verify-once refused ${once.ok ? "" : `${once.file} (${once.reason})`}`).toBe(true);
          tally.agreed++;
        } else if (once.ok) {
          // The one designed difference: verify-once never reads a file the VM already holds, so a damaged or absent
          // copy of it on the server goes unnoticed while every byte the process gets is still the pinned one.
          const damaged = chosen.filter((_file, index) => states[index] !== "intact").map(file => file.request.file);
          expect(damaged.length > 0 && damaged.every(name => held.has(name)), `${where}: verify-once accepted ${damaged.join(",")} it did not hold`).toBe(true);
          tally.heldNotReread++;
        } else {
          // Both refuse; verify-once names a file it had to read, which the server damaged.
          const index = chosen.findIndex(file => file.request.file === once.file);
          expect(index >= 0 && states[index] !== "intact" && !held.has(once.file), `${where}: verify-once refused ${once.file} (${once.reason}); per-start ${every.file} (${every.reason})`).toBe(true);
          tally.refusedBoth++;
        }
      }
      store.dispose();
    }
    // Every branch of the comparison is reached.
    expect(Math.min(tally.agreed, tally.heldNotReread, tally.refusedBoth)).toBeGreaterThan(SEEDS);
  }, 120_000);
});
