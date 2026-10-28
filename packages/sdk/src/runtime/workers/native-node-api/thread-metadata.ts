import { exactKeys, record } from "../../decode.js";
import { protocol } from "../../js-process/codec.js";
import { decodeForkExecArgv } from "../../protocol/assistance-fork.js";

export const NATIVE_TASK_CONTROL_VERSION = 4;
/** 7 (main): the mailbox header's fourth Int32 counts posted Linux requests (JS process protocol 2).
 * 15 (native parity): captured runtime and capability metadata. 16 joins both. 17: the profile
 * carries Rust's ordered dependency roots and admission basis (ADR 0026). */
export const NATIVE_PROCESS_BOOTSTRAP_VERSION = 17;

export interface NativeThreadMetadata {
  readonly port: MessagePort;
  readonly data: unknown;
  readonly execArgv: readonly string[];
  readonly transfers: readonly (ArrayBuffer | MessagePort)[];
  readonly autoSelectFamily: SharedArrayBuffer | null;
}
export function decodeThreadMetadata(input: unknown): NativeThreadMetadata {
  const value = record(input, "native thread metadata"); exactKeys(value, ["port", "data", "execArgv", "transfers", "autoSelectFamily"]);
  const port = value["port"], transfers = value["transfers"];
  if (!(port instanceof MessagePort) || !Array.isArray(transfers) || transfers.length > 64) protocol("Invalid native thread transfer list");
  const shared = value["autoSelectFamily"];
  if (shared !== null && (!(shared instanceof SharedArrayBuffer) || shared.byteLength !== 4 || shared.growable)) protocol("Invalid shared socket defaults buffer");
  if (shared !== null) {
    const flag = Atomics.load(new Int32Array(shared), 0);
    if (flag !== 0 && flag !== 1) protocol("Invalid shared socket family flag");
  }
  return { port, autoSelectFamily: shared, data: value["data"], execArgv: decodeForkExecArgv(value["execArgv"]), transfers: transfers.map((value: unknown) => { if (!(value instanceof ArrayBuffer) && !(value instanceof MessagePort)) protocol("Invalid native thread transfer"); return value; }) };
}
