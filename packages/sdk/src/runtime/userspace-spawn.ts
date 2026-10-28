import { VMError } from "./errors.ts";

export type UserspaceSpawnResult =
  | { readonly kind: "spawned"; readonly pid: number }
  | { readonly kind: "error"; readonly errno: number };

/** API57 keeps Linux admission errors separate from Wasm boundary status. */
export function decodeUserspaceSpawnResult(bytes: Uint8Array): UserspaceSpawnResult {
  if (bytes.byteLength !== 8) throw new VMError("PROTOCOL_ERROR", "Userspace spawn result has an invalid length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pid = view.getUint32(0, true), errno = view.getUint32(4, true);
  if (pid > 0 && pid <= 0x7fff_ffff && errno === 0) return { kind: "spawned", pid };
  if (pid === 0 && errno > 0 && errno <= 4095) return { kind: "error", errno };
  throw new VMError("PROTOCOL_ERROR", "Userspace spawn result has an invalid PID or errno");
}
