import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { VMError } from "@oxvm/sdk";

async function find(directory: string, name: string): Promise<string | undefined> {
  const path = resolve(directory, name);
  try { await lstat(path); return path; }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function discover(directory: string, canonical: string, legacy: string): Promise<string | undefined> {
  const [current, previous] = await Promise.all([find(directory, canonical), find(directory, legacy)]);
  if (current !== undefined && previous !== undefined) throw new VMError("INVALID_ARGUMENT", `Both ${canonical} and ${legacy} exist; select the intended file explicitly`, { reason: "project-file-conflict" });
  return current ?? previous;
}

export function defaultProjectConfig(directory: string): Promise<string | undefined> {
  return discover(directory, "oxvm.config.ts", "oxidevm.config.ts");
}

export function defaultSnapshotRecipe(directory: string): Promise<string | undefined> {
  return discover(directory, "oxvm.snapshot.ts", "oxidevm.snapshot.ts");
}
