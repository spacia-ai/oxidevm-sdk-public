import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler, transformSource } from "./compiler.ts";
import { exactKeys, integer, record, string } from "../../decode.ts";
import { createLocalModuleLoader } from "./module-loader.ts";
import { createAsyncContext } from "./async-context.ts";
import { installSchedulingContext } from "./scheduling-context.ts";
import { installPromiseContext } from "./promise-context.ts";
import { installGeneratedFunctions } from "./generated-functions.ts";
import { publishRequest, waitForReply } from "./mailbox.ts";

declare const ASSISTANCE_CONTEXT_SOURCE: string;
declare const ASSISTANCE_SYSTEM_SOURCE: string;
declare const ASSISTANCE_MODULE_CASES: string;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void run(event.data).catch(() => self.close());
});

async function run(value: unknown): Promise<void> {
  const message = record(value, "probe process input");
  exactKeys(message, ["buffer", "sequence", "bytes", "compilerModule"]);
  const buffer = message["buffer"];
  const bytes = message["bytes"];
  if (!(buffer instanceof SharedArrayBuffer) || !(bytes instanceof ArrayBuffer)) {
    throw new TypeError("invalid probe buffers");
  }
  const compilerModule = message["compilerModule"];
  if (!(compilerModule instanceof WebAssembly.Module)) throw new TypeError("missing compiler module");
  const compiler = initializeCompiler(compilerNamespace, compilerModule);
  const source = transformSource(compiler, `function runFixture() { return (${ASSISTANCE_CONTEXT_SOURCE}); }`, "commonjs", "/fixture/async-context.js");
  const sequence = integer(message["sequence"], "probe sequence", 1, 0x7fff_ffff);
  let networkDenied = false;
  try {
    await fetch("/network-must-be-denied");
  } catch {
    networkDenied = true;
  }
  const childDenied = await new Promise<boolean>((resolve) => {
    try {
      const child = new Worker("/process.worker.js", { type: "module" });
      const deadline = setTimeout(() => { child.terminate(); resolve(false); }, 1000);
      child.onerror = (error) => {
        clearTimeout(deadline);
        error.preventDefault();
        child.terminate();
        resolve(true);
      };
      child.onmessage = () => { clearTimeout(deadline); child.terminate(); resolve(false); };
      child.postMessage({});
    } catch {
      resolve(true);
    }
  });
  publishRequest(buffer, sequence, new Uint8Array(bytes));
  self.postMessage({ kind: "pending" });
  const result = new Uint8Array(waitForReply(buffer, sequence, 10_000)).buffer;
  const runtime = createAsyncContext();
  const restore = installPromiseContext(runtime, globalThis);
  const restoreScheduler = installSchedulingContext(runtime, globalThis);
  // The probe expression evaluator is trusted bootstrap code, captured before
  // application eval is denied by the generated-code boundary.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function("AsyncLocalStorage", `${source.code}\nreturn runFixture();`);
  const restoreFunctions = installGeneratedFunctions(compiler, globalThis);
  try {
    // ADR 0012 permits evaluation only in the isolated process worker. This
    // probe evaluates a build-pinned fixture, never a message-supplied source.
    const context: unknown = await Reflect.apply(evaluate, undefined, [runtime.AsyncLocalStorage]);
    const corpus: unknown = JSON.parse(ASSISTANCE_MODULE_CASES);
    if (!Array.isArray(corpus)) throw new TypeError("invalid module corpus");
    const modules: { name: string; observed: string }[] = [];
    for (const input of corpus) {
      const fixture = record(input, "module fixture");
      const files = record(fixture["files"], "module fixture files");
      const loader = createLocalModuleLoader(compiler, ASSISTANCE_SYSTEM_SOURCE, {
        resolve(specifier, parent) { return new URL(specifier, `file://${parent}`).pathname; },
        read(path) { return { source: string(files[path.slice(1)], "module fixture source"), format: path.endsWith(".json") ? "json" : path.endsWith(".cjs") ? "commonjs" : "module" }; },
      });
      let observed: string;
      try { observed = JSON.stringify({ kind: "value", value: await loader.import("/entry.mjs") }); }
      catch (error) { observed = JSON.stringify({ kind: "error", name: error instanceof Error ? error.name : "non-error" }); }
      modules.push({ name: string(fixture["name"], "module fixture name"), observed });
    }
    self.postMessage({ kind: "complete", bytes: result, isolated: crossOriginIsolated, networkDenied, childDenied,
      modules: JSON.stringify(modules),
      context: context === undefined ? "undefined" : JSON.stringify(context) }, [result]);
  } finally {
    restoreFunctions();
    restoreScheduler();
    restore();
  }
}
