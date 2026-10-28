import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrustedImageKey } from "../image.js";
import { record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { readImageBundle } from "./bundle.js";
import type { ReadImageBundle } from "./bundle.js";

/**
 * Reads a default-image bundle with the reader that will consume it. Each script that pins, reviews or
 * publishes a default calls this first, so a bundle this SDK cannot read stops the run before anything is
 * pinned. The error keeps its code and reason and names the directory.
 */
export async function requireReadableDefaultImage(directory: string, trust?: TrustedImageKey, signal?: AbortSignal): Promise<ReadImageBundle> {
  try {
    return await readImageBundle(directory, trust, signal);
  } catch (error: unknown) {
    if (error instanceof VMError) throw new VMError(error.code, `${directory}: ${error.message}`, { ...error.detail, directory });
    throw error;
  }
}

/**
 * The digest that names a retired default in history. It is the manifest digest the bundle's own lock
 * records. Retiring a default does not verify it: the replaced bundle is moved aside, not pinned, and its
 * signing key may differ from the current trust anchor (the Full Linux default keeps an earlier key).
 */
export async function defaultHistoryKey(directory: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(join(directory, "image.lock.json"), "utf8"));
  return string(record(value, "default image lock")["manifestSHA256"], "default image manifest digest");
}
