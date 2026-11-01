import { createHash } from "node:crypto";
import { VMError } from "../../runtime/errors.js";
import { MANIFEST_INVALID } from "../../wasm/decode-support.js";

/** One line of a release's `SHA256SUMS`. */
export interface SumEntry {
  readonly name: string;
  readonly sha256: string;
}

/** A flat release file name: it starts with a letter or digit, so neither `.` nor `..` nor a hidden file qualifies. */
export const RELEASE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const MAX_SUMS_BYTES = 64 * 1024;
const LINE = /^([0-9a-f]{64}) {2}(.+)$/u;

function invalid(message: string): never {
  throw new VMError("INVALID_ARGUMENT", `SHA256SUMS ${message}`, { reason: MANIFEST_INVALID });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The canonical bytes: one `<sha256>␣␣<name>` line per file, sorted by name, each ending in a newline. */
export function formatSums(entries: readonly SumEntry[]): Uint8Array<ArrayBuffer> {
  const sorted = [...entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return new TextEncoder().encode(sorted.map(entry => `${entry.sha256}  ${entry.name}\n`).join(""));
}

/** Parses `SHA256SUMS` strictly: canonical form only, so the file's own digest identifies the release. */
export function parseSums(bytes: Uint8Array): readonly SumEntry[] {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SUMS_BYTES) invalid(`must be between 1 and ${String(MAX_SUMS_BYTES)} bytes`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalid("is not UTF-8"); }
  if (!text.endsWith("\n") || text.includes("\r")) invalid("must use LF line ends and end with one");
  const entries = text.slice(0, -1).split("\n").map((line): SumEntry => {
    const match = LINE.exec(line);
    const [, sha256, name] = match ?? [];
    if (sha256 === undefined || name === undefined || !RELEASE_FILE_NAME.test(name)) return invalid(`has a malformed line: ${JSON.stringify(line.slice(0, 80))}`);
    return { name, sha256 };
  });
  if (entries.length > 256) invalid("lists more than 256 files");
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) invalid("lists a file twice");
  const canonical = formatSums(entries);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((byte, index) => byte === bytes[index])) invalid("is not in canonical form (sorted by name, no duplicates)");
  return entries;
}

/** A release is named by the digest of its canonical `SHA256SUMS`. */
export function releaseId(sums: Uint8Array): string {
  parseSums(sums);
  return sha256Hex(sums);
}
