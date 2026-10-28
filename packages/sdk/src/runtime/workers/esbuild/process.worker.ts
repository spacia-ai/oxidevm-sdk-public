import { fetchPinnedBytes } from "../../../engine-assets.js";
import { integer } from "../../decode.js";
import { ESBUILD } from "../../esbuild-identity.js";
import { VMError } from "../../errors.js";
import { serveOwnedProcess } from "../../js-process/serve.js";
import { goFilesystem } from "./go-files.js";
import { goNetwork } from "./go-network.js";

interface GoRuntime {
  argv: string[];
  env: Record<string, string>;
  readonly importObject: WebAssembly.Imports;
  exit(code: number): void;
  run(instance: WebAssembly.Instance): Promise<void>;
}
declare const Go: { new(): GoRuntime };

/** Only the authenticated compiler executes. Upstream plugins stay in their parent process. */
serveOwnedProcess(async (client, context) => {
  const info = await context.process.info();
  if (info.args[1] !== `--service=${ESBUILD.version}` || info.args.length !== 2 && (info.args.length !== 3 || info.args[2] !== "--ping")) throw new VMError("FEATURE_NOT_AVAILABLE", "This compiler worker supports only the pinned esbuild service");
  const moduleUrl = new URL(self.location.href).searchParams.get("module");
  if (moduleUrl === null || new URL(moduleUrl).origin !== self.location.origin) throw new VMError("PROTOCOL_ERROR", "Compiler asset origin is invalid");
  const bytes = await fetchPinnedBytes(new URL(moduleUrl), ESBUILD.wasmSHA256, "compiler", AbortSignal.timeout(120_000), undefined, ESBUILD.wasmBytes);
  const failure = Promise.withResolvers<never>(), failed = (error: unknown) => { failure.reject(error); };
  const filesystem = goFilesystem(client, info.cwd, failed);
  Reflect.set(globalThis, "fs", filesystem.fs);
  Reflect.set(globalThis, "path", filesystem.path);
  Reflect.set(globalThis, "process", { pid: info.pid, ppid: info.parentPid ?? 0, cwd: filesystem.cwd, chdir: (path: string) => { filesystem.chdir(path); },
    getuid: () => info.uid, geteuid: () => info.uid, getgid: () => info.gid, getegid: () => info.gid,
    getgroups: () => { throw new VMError("FEATURE_NOT_AVAILABLE", "esbuild does not use supplementary-group enumeration"); },
    umask: () => { throw new VMError("FEATURE_NOT_AVAILABLE", "esbuild does not change its inherited umask"); } });
  Reflect.set(globalThis, "oxidevmEsbuild", goNetwork(context, client, failed));
  const go = new Go(); let exitCode = 0;
  go.argv = [...info.args];
  go.env = Object.fromEntries(info.environment.map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
  go.exit = code => { exitCode = integer(code, "esbuild exit status", 0, 255); };
  const reject = (event: PromiseRejectionEvent): void => { event.preventDefault(); const error: unknown = event.reason; failed(error); };
  self.addEventListener("unhandledrejection", reject);
  try {
    const instance = await WebAssembly.instantiate(bytes, go.importObject);
    await Promise.race([go.run(instance.instance), failure.promise]);
    return exitCode;
  } finally { self.removeEventListener("unhandledrejection", reject); }
});
