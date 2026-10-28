import * as compilerNamespace from "@swc/wasm-web";
import * as nextCompilerNamespace from "oxidevm:next-swc-bindings";
import { initializeNextCompiler } from "./next-compiler.js";
import { initializeCompiler } from "./compiler.js";
import { decodeProcessStart } from "./process-start.js";
import { ProcessIO } from "./process-io.js";
import { runLocalProcess } from "./process-runtime.js";
import { restrictProcessControls } from "./process-controls.js";

declare const ASSISTANCE_SYSTEM_SOURCE: string;
declare const ASSISTANCE_NODE_API_VERSION: string;

let io: ProcessIO | undefined;
let started = false;
const postToBroker = self.postMessage.bind(self);

function failed(error: unknown): void {
  if (io === undefined) {
    // An invalid bootstrap has no trusted identity with which to emit a reply.
    queueMicrotask(() => { throw error; });
  } else io.fail(error);
}
self.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  event.preventDefault();
  const error: unknown = event.reason;
  if (io === undefined) failed(error); else io.applicationException(error, "unhandledRejection", event.promise);
});
self.addEventListener("error", event => {
  event.preventDefault(); const error: unknown = event.error ?? new Error(event.message);
  if (io === undefined) failed(error); else io.applicationException(error);
});
export function startProcess(value: unknown): void {
  try {
    if (started) {
      if (io === undefined) throw new Error("Process initialization failed");
      io.receive(value);
      return;
    }
    started = true;
    const input = decodeProcessStart(value);
    io = new ProcessIO(input.identity, input.buffer, value => postToBroker(value), input.trafficBytes);
    restrictProcessControls(self);
    const compiler = initializeCompiler(compilerNamespace, input.compilerModule);
    const nextCompiler = initializeNextCompiler(nextCompilerNamespace, input.nextCompilerModule);
    void runLocalProcess({ ...input, entry: { kind: "file", path: input.entry } }, io, { compiler, systemSource: ASSISTANCE_SYSTEM_SOURCE, nextCompiler, httpParser: input.httpParserModule, metadata: { nodeVersion: ASSISTANCE_NODE_API_VERSION, execPath: "/usr/local/bin/oxidevm-node", argv0: "/usr/local/bin/oxidevm-node" } }).catch(failed);
  } catch (error) { failed(error); }
}
self.addEventListener("message", (event: MessageEvent<unknown>) => startProcess(event.data));
