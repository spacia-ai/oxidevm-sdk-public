import { exactKeys, integer, protocolError, record, string } from "../decode.js";
import { decodeBytes } from "./decoders.js";
import { MAX_AGENT_PAYLOAD_BYTES } from "../agent-protocol.js";

export interface FileMount {
  readonly rootTreeSha256: string;
  readonly workspaceBaseSha256: string;
  readonly cpuProfile: "x86-64-v2" | "x86-64-v3";
  readonly rootfs: Uint8Array;
}
export function decodeFileMount(value: unknown): FileMount {
  const input = record(value, "Userspace file mount");
  exactKeys(input, ["rootTreeSha256", "workspaceBaseSha256", "cpuProfile", "rootfs"]);
  const rootTreeSha256 = string(input["rootTreeSha256"], "root identity"); const workspaceBaseSha256 = string(input["workspaceBaseSha256"], "workspace base identity");
  if (!/^[0-9a-f]{64}$/u.test(rootTreeSha256) || !/^[0-9a-f]{64}$/u.test(workspaceBaseSha256)) throw protocolError("invalid file mount identity");
  const cpuProfile = input["cpuProfile"];
  if (cpuProfile !== "x86-64-v2" && cpuProfile !== "x86-64-v3") throw protocolError("invalid file mount CPU profile");
  const rootfs = decodeBytes(input["rootfs"]); integer(rootfs.byteLength, "file mount bytes", 4, MAX_AGENT_PAYLOAD_BYTES);
  return { rootTreeSha256, workspaceBaseSha256, cpuProfile, rootfs };
}
export function decodeFileRequestBytes(value: unknown): Uint8Array {
  const bytes = decodeBytes(value); integer(bytes.byteLength, "file request bytes", 5, 16 * 1024 * 1024 + 8_256); return bytes;
}
export function decodeFileResponseBytes(value: unknown): Uint8Array {
  const bytes = decodeBytes(value); integer(bytes.byteLength, "file response bytes", 6, MAX_AGENT_PAYLOAD_BYTES); return bytes;
}
export function decodeChangeCursor(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) throw protocolError("invalid workspace change cursor"); return value;
}
