import { decodeProcessId } from "../../values.js";
import { Reader, Writer, protocol, decodeJSIdentity, type JSProcessIdentity } from "./codec.js";
export type { JSProcessIdentity } from "./codec.js";

export interface JSCompletion extends JSProcessIdentity { readonly sequence: number; readonly pid: number; readonly errno: number; readonly value: bigint; readonly payload: Uint8Array }
export function encodeJSRequest(identity: JSProcessIdentity, sequence: number, operation: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Writer().raw(new TextEncoder().encode("OXJR")).u32(4).u64(identity.generation).u64(identity.id).u64(sequence).u32(operation).raw(payload).finish();
}
export function decodeJSCompletion(bytes: Uint8Array): JSCompletion {
  const r = new Reader(bytes);
  if (new TextDecoder().decode(r.raw(4)) !== "OXJP" || r.u32() !== 1) protocol("Linux completion version mismatch");
  const { generation, id } = decodeJSIdentity(r.u64(), r.u64());
  const bigSequence = r.u64(), pid = decodeProcessId(r.u32()), errno = r.u32(), value = r.u64(), payload = r.blob(); r.end();
  if (generation === 0n || id === 0n || bigSequence === 0n || bigSequence > BigInt(Number.MAX_SAFE_INTEGER) || errno > 4095 || (errno !== 0 && (value !== 0n || payload.byteLength !== 0))) protocol("Invalid Linux completion identity or result");
  return { generation, id, sequence: Number(bigSequence), pid, errno, value, payload };
}
