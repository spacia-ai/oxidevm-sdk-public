/** One record of a test workspace snapshot: tag, mode, absolute path and payload. */
export type WorkspaceSnapshotRecord = readonly [tag: number, mode: number, path: string, payload: Uint8Array<ArrayBuffer>];

/**
 * An OXRF workspace snapshot of `records`: v5, or v6 (System's capture), whose entries carry
 * ownership fields (here unowned) and which may record the /workspace root.
 */
export function workspaceSnapshot(records: readonly WorkspaceSnapshotRecord[], version: 5 | 6 = 5): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const headerBytes = version === 6 ? 20 : 12;
  const encoded = records.map(([tag, mode, path, payload]) => ({ tag, mode, path: encoder.encode(path), payload }));
  const bytes = new Uint8Array(encoded.reduce((total, entry) => total + headerBytes + entry.path.byteLength + entry.payload.byteLength, 12));
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("OXRF"));
  view.setUint16(4, version, true);
  view.setUint32(8, encoded.length, true);
  let offset = 12;
  for (const entry of encoded) {
    bytes[offset] = entry.tag;
    view.setUint16(offset + 2, entry.mode, true);
    view.setUint32(offset + 4, entry.path.byteLength, true);
    view.setUint32(offset + 8, entry.payload.byteLength, true);
    bytes.set(entry.path, offset + headerBytes);
    bytes.set(entry.payload, offset + headerBytes + entry.path.byteLength);
    offset += headerBytes + entry.path.byteLength + entry.payload.byteLength;
  }
  return bytes;
}
import { readFileSync } from "node:fs";

export function richWorkspaceSnapshot(): Uint8Array<ArrayBuffer> {
  const line = readFileSync(new URL("../../../../../tests/fixtures/workspace/metadata.hex", import.meta.url), "utf8")
    .split("\n").find(value => value.startsWith("rich "));
  if (line === undefined) throw new Error("missing shared metadata fixture");
  return Uint8Array.from(Buffer.from(line.slice(5), "hex"));
}
