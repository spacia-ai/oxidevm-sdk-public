import { loadAssistanceArtifact } from "../../assistance-artifacts.js";
import { serializeUnknownError } from "../../errors.js";
import { decodeAssistanceBootstrap } from "../../protocol/assistance-bootstrap.js";
import { ExecutionBroker } from "./broker.js";

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const input = decodeAssistanceBootstrap(event.data);
  void initialize(input).catch((error: unknown) => {
    input.port.postMessage({ kind: "bootstrap-failed", binding: input.binding, nonce: input.nonce, error: serializeUnknownError(error) });
    input.port.close();
    self.close();
  });
}, { once: true });

async function initialize(input: ReturnType<typeof decodeAssistanceBootstrap>): Promise<void> {
  if (!crossOriginIsolated) throw new Error("Execution origin is not cross-origin isolated");
  const deadline = AbortSignal.timeout(60_000);
  const [compilerBytes, runtime, nextCompilerBytes, httpParserBytes] = await Promise.all([
    loadAssistanceArtifact(new URL("/compiler.wasm", self.location.origin), input.artifacts.compiler, deadline),
    loadAssistanceArtifact(new URL("/process-runtime.js", self.location.origin), input.artifacts.runtime, deadline),
    loadAssistanceArtifact(new URL("/next-compiler.wasm", self.location.origin), input.artifacts.nextCompiler.wasm, deadline),
    loadAssistanceArtifact(new URL("/http-parser.wasm", self.location.origin), input.artifacts.httpParser, deadline),
  ]);
  const [compiler, nextCompiler, httpParser] = await Promise.all([WebAssembly.compile(compilerBytes), WebAssembly.compile(nextCompilerBytes), WebAssembly.compile(httpParserBytes)]);
  new ExecutionBroker(input.port, input.binding, compiler, runtime, nextCompiler, httpParser);
  input.port.postMessage({ kind: "broker-ready", binding: input.binding, nonce: input.nonce,
    ...(input.credits?.[1] === undefined ? {} : { receipt: { ...input.credits[1], kind: "return" } }) });
}
