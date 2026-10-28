/// <reference lib="webworker" />

import { serializeUnknownError } from "../errors.js";
import {
  AOT_COMPILER_PROTOCOL_VERSION,
  type AotCompilerRequest,
  type AotCompilerResponse,
  decodeAotCompilerRequest,
} from "./control/aot-compiler-protocol.js";
import { validateAotPackModule } from "./control/aot-pack.js";

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void compile(event.data);
});

async function compile(value: unknown): Promise<void> {
  let request: AotCompilerRequest;
  try {
    request = decodeAotCompilerRequest(value);
  } catch (error) {
    self.postMessage({
      version: AOT_COMPILER_PROTOCOL_VERSION,
      type: "protocol-failure",
      error: serializeUnknownError(error),
    });
    self.close();
    return;
  }
  try {
    const response = await compilePack(request);
    self.postMessage(response);
  } catch (error) {
    const response: AotCompilerResponse = {
      version: AOT_COMPILER_PROTOCOL_VERSION,
      type: "failed",
      id: request.id,
      runtimeEpoch: request.runtimeEpoch,
      catalogGeneration: request.catalogGeneration,
      sha256: request.sha256,
      reason: error instanceof Error ? error.message : "non-Error AOT compiler failure",
    };
    self.postMessage(response);
  }
}

async function compilePack(request: AotCompilerRequest): Promise<AotCompilerResponse> {
  const fetchStarted = performance.now();
  const response = await fetch(request.url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`AOT pack fetch failed with status ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const fetchMilliseconds = performance.now() - fetchStarted;
  if (bytes.byteLength !== request.byteLength) throw new Error("AOT pack length does not match its catalog");

  const hashBytes = bytes.slice();
  const compileBytes = bytes.slice();
  const hashStarted = performance.now();
  const compileStarted = performance.now();
  const [digestBytes, module] = await Promise.all([
    crypto.subtle.digest("SHA-256", hashBytes.buffer),
    WebAssembly.compile(compileBytes),
  ]);
  const finished = performance.now();
  const digest = [...new Uint8Array(digestBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== request.sha256) throw new Error("AOT pack digest does not match its catalog");
  validateAotPackModule(module, request);
  return {
    version: AOT_COMPILER_PROTOCOL_VERSION,
    type: "compiled",
    id: request.id,
    runtimeEpoch: request.runtimeEpoch,
    catalogGeneration: request.catalogGeneration,
    sha256: request.sha256,
    module,
    fetchMilliseconds,
    hashMilliseconds: finished - hashStarted,
    compileMilliseconds: finished - compileStarted,
  };
}
