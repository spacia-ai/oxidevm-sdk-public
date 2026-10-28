import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { MAX_JIT_MODULE_BYTES } from "../../jit-cache.js";
import { isAttentionCounter, type AttentionCounter } from "../../host-attention.js";

/** The JIT compiler worker's protocol: translated module bytes in, a compiled
 * `WebAssembly.Module` out. Version 2 adds the browser error's name to a failed compile, so
 * running out of executable code memory is told apart from a rejected module. */
export const JIT_COMPILER_PROTOCOL_VERSION = 2;

/** Bound on the error name a failed compile carries. */
const MAX_ERROR_NAME = 64;

/** Messages the execution worker sends. `attach` passes the counter the compiler bumps before
 * posting each response, so the guest's slice can end early to install it. */
export type JitCompilerRequest =
  | {
      readonly version: typeof JIT_COMPILER_PROTOCOL_VERSION;
      readonly type: "attach";
      readonly ready: AttentionCounter | null;
    }
  | {
      readonly version: typeof JIT_COMPILER_PROTOCOL_VERSION;
      readonly type: "compile";
      readonly id: number;
      readonly epoch: number;
      readonly bytes: Uint8Array<ArrayBuffer>;
    };

export type JitCompilerResponse =
  | {
      readonly version: typeof JIT_COMPILER_PROTOCOL_VERSION;
      readonly type: "compiled";
      readonly id: number;
      readonly epoch: number;
      readonly module: WebAssembly.Module;
      readonly compileMilliseconds: number;
    }
  | {
      readonly version: typeof JIT_COMPILER_PROTOCOL_VERSION;
      readonly type: "failed";
      readonly id: number;
      readonly epoch: number;
      /** The browser error's `name`, such as `CompileError` or `RangeError`. */
      readonly errorName: string;
      readonly reason: string;
    };

const MAX_REQUEST_ID = 0x7fff_ffff;

export function decodeJitCompilerRequest(value: unknown): JitCompilerRequest {
  const message = record(value, "JIT compiler request");
  if (integer(message["version"], "JIT compiler protocol") !== JIT_COMPILER_PROTOCOL_VERSION) {
    throw protocol("JIT compiler request version is invalid");
  }
  const type = string(message["type"], "JIT compiler request type");
  if (type === "attach") {
    exactKeys(message, ["version", "type", "ready"]);
    const ready = message["ready"];
    if (ready !== null && !isAttentionCounter(ready)) {
      throw protocol("JIT compiler ready counter is invalid");
    }
    return { version: JIT_COMPILER_PROTOCOL_VERSION, type, ready };
  }
  if (type !== "compile") throw protocol("JIT compiler request type is invalid");
  exactKeys(message, ["version", "type", "id", "epoch", "bytes"]);
  const bytes = message["bytes"];
  if (
    !(bytes instanceof Uint8Array)
    || !(bytes.buffer instanceof ArrayBuffer)
    || bytes.byteLength === 0
    || bytes.byteLength > MAX_JIT_MODULE_BYTES
  ) {
    throw protocol("JIT compiler module bytes are invalid");
  }
  return {
    version: JIT_COMPILER_PROTOCOL_VERSION,
    type,
    id: integer(message["id"], "JIT compiler request ID", 1, MAX_REQUEST_ID),
    epoch: integer(message["epoch"], "JIT compiler epoch", 1, MAX_REQUEST_ID),
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };
}

export function decodeJitCompilerResponse(value: unknown): JitCompilerResponse {
  const message = record(value, "JIT compiler response");
  if (integer(message["version"], "JIT compiler protocol") !== JIT_COMPILER_PROTOCOL_VERSION) {
    throw protocol("JIT compiler response version is invalid");
  }
  const type = string(message["type"], "JIT compiler response type");
  const id = integer(message["id"], "JIT compiler response ID", 1, MAX_REQUEST_ID);
  const epoch = integer(message["epoch"], "JIT compiler epoch", 1, MAX_REQUEST_ID);
  if (type === "failed") {
    exactKeys(message, ["version", "type", "id", "epoch", "errorName", "reason"]);
    const errorName = string(message["errorName"], "JIT compiler failure name");
    if (errorName.length > MAX_ERROR_NAME) throw protocol("JIT compiler failure name is too long");
    return {
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type,
      id,
      epoch,
      errorName,
      reason: string(message["reason"], "JIT compiler failure"),
    };
  }
  if (type !== "compiled") throw protocol("JIT compiler response type is invalid");
  exactKeys(message, ["version", "type", "id", "epoch", "module", "compileMilliseconds"]);
  const module = message["module"];
  if (!(module instanceof WebAssembly.Module)) {
    throw protocol("JIT compiler response module is invalid");
  }
  const compileMilliseconds = message["compileMilliseconds"];
  if (
    typeof compileMilliseconds !== "number"
    || !Number.isFinite(compileMilliseconds)
    || compileMilliseconds < 0
  ) {
    throw protocol("JIT compiler compile time is invalid");
  }
  return { version: JIT_COMPILER_PROTOCOL_VERSION, type, id, epoch, module, compileMilliseconds };
}

function protocol(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}
