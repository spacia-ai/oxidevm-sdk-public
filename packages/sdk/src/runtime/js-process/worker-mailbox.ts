import { integer } from "../decode.js";
import { JS_MAILBOX_BYTES, protocol } from "./codec.js";

/** The execution owner and isolated-origin broker use one synchronous reply encoder. */
export function writeWorkerMailbox(header: Int32Array, body: Uint8Array, sequence: number, errno: number, value: bigint, payload: Uint8Array): void {
  integer(sequence, "Linux mailbox sequence", 1, 0x7fff_ffff); integer(errno, "Linux mailbox errno", 0, 4095);
  const length = payload.byteLength + 12;
  if (body.byteLength !== JS_MAILBOX_BYTES - 16 || length > body.byteLength || value < 0n || value > 0xffff_ffff_ffff_ffffn) protocol("Linux response exceeds mailbox bounds");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  view.setUint32(0, errno, true); view.setBigUint64(4, value, true); body.set(payload, 12);
  Atomics.store(header, 1, length); Atomics.store(header, 2, sequence); Atomics.store(header, 0, 1); Atomics.notify(header, 0);
}
