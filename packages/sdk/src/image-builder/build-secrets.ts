import { resolve } from "node:path";
import { VMError } from "../runtime/errors.js";
import type { BuildImageOptions } from "./contracts.js";
import { readSourceFile } from "./files.js";

export interface LoadedBuildSecrets {
  readonly mounts: readonly { readonly id: string; readonly bytes: Uint8Array }[];
  readonly forbidden: readonly Uint8Array[];
}

/** Private mount contents stay in bounded author memory, outside build reports. */
export async function loadBuildSecrets(options: BuildImageOptions): Promise<LoadedBuildSecrets> {
  const values = new Map<string, Buffer>(); let total = 0;
  const mounts: { readonly id: string; readonly bytes: Uint8Array }[] = [];
  for (const secret of options.secrets ?? []) {
    const raw = Buffer.from((await readSourceFile(resolve(options.recipeDir, secret.file), 1024 ** 2, options.signal)).bytes);
    total += raw.length;
    if (raw.length === 0 || total > 4 * 1024 ** 2) throw new VMError("INVALID_ARGUMENT", "secret mount inputs exceed their byte bound or are empty");
    mounts.push({ id: secret.id, bytes: raw });
    const trimmed = Buffer.from(raw.toString("utf8").trim());
    for (const value of [raw, trimmed, Buffer.from(raw.toString("base64")), Buffer.from(raw.toString("hex")), Buffer.from(trimmed.toString("base64"))]) {
      if (value.length !== 0) values.set(value.toString("base64"), value);
    }
  }
  return { mounts, forbidden: [...values.values()] };
}
