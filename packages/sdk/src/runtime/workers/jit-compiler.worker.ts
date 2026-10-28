/// <reference lib="webworker" />

// Compiles translated JIT modules off the guest's execution thread. The execution worker bounds
// how many compiles are in flight; responses may arrive in any order and each follows a bump of
// the shared ready counter, so the execution worker can end its slice and install the module.

import { serializeUnknownError } from "../errors.js";
import { postCounted, type AttentionCounter } from "../host-attention.js";
import {
  JIT_COMPILER_PROTOCOL_VERSION,
  type JitCompilerRequest,
  type JitCompilerResponse,
  decodeJitCompilerRequest,
} from "./control/jit-compiler-protocol.js";

let ready: AttentionCounter | null = null;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  let request: JitCompilerRequest;
  try {
    request = decodeJitCompilerRequest(event.data);
  } catch (error) {
    fail(error);
    return;
  }
  if (request.type === "attach") {
    ready = request.ready;
    return;
  }
  compile(request).catch(fail);
});

function fail(error: unknown): void {
  self.postMessage({
    version: JIT_COMPILER_PROTOCOL_VERSION,
    type: "protocol-failure",
    error: serializeUnknownError(error),
  });
  self.close();
}

async function compile(request: Extract<JitCompilerRequest, { readonly type: "compile" }>): Promise<void> {
  const started = performance.now();
  let response: JitCompilerResponse;
  try {
    const module = await WebAssembly.compile(request.bytes);
    response = {
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "compiled",
      id: request.id,
      epoch: request.epoch,
      module,
      compileMilliseconds: performance.now() - started,
    };
  } catch (error) {
    response = {
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "failed",
      id: request.id,
      epoch: request.epoch,
      errorName: error instanceof Error ? error.name.slice(0, 64) : "non-Error",
      reason: error instanceof Error ? error.message : "non-Error JIT compiler failure",
    };
  }
  postCounted(ready, () => { self.postMessage(response); });
}
