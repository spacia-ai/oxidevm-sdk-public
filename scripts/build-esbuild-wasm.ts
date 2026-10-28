// Compiler assets are lazy-loaded. They do not belong to the initial shell download.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ESBUILD } from "../packages/sdk/src/runtime/esbuild-identity.ts";
import { build as bundleWorker } from "esbuild";
import { record, string } from "../packages/sdk/src/runtime/decode.ts";
import { patchGoFilesystem, replaceOnce } from "./esbuild/platform-patch.ts";
import { minifyJavaScript } from "./production-javascript.ts";

const root = resolve(import.meta.dirname, ".."), cache = join(root, ".cache/esbuild");
const output = join(root, "packages/sdk/assets/compilers");
const env = { ...process.env, GOTOOLCHAIN: "local", GOENV: "off", GOFLAGS: "", GOEXPERIMENT: "", GOFIPS140: "off", GOWASM: "", GOWORK: "off",
  GOMODCACHE: join(cache, "gomod"), GOCACHE: join(cache, "gocache"), CGO_ENABLED: "0" };
function go(args: string[], cwd = root, extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("go", args, { cwd, env: { ...env, ...extra }, encoding: "utf8", maxBuffer: 8 * 1024 ** 2 });
  if (result.error !== undefined || result.status !== 0) throw new Error(`go ${args[0] ?? ""} failed: ${result.stderr}`, { cause: result.error });
  return result.stdout.trim();
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function writableDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writableDirectories(join(directory, entry.name));
}
assert.equal(go(["env", "GOVERSION"]), ESBUILD.goVersion, "Use the pinned Go toolchain");
const goroot = go(["env", "GOROOT"]);
const filesystem = await readFile(join(goroot, "src/syscall/fs_js.go"), "utf8");
const errors = await readFile(join(goroot, "src/syscall/tables_js.go"), "utf8"), linuxErrors = await readFile(join(goroot, "src/syscall/zerrors_linux_amd64.go"), "utf8");
const runtime = await readFile(join(goroot, "lib/wasm/wasm_exec.js"));
const toolchainSHA256 = hash(await readFile(join(goroot, "bin/go")));
assert.equal(hash(filesystem), ESBUILD.goFilesystemSHA256, "Go filesystem source changed");
assert.equal(hash(errors), ESBUILD.goErrorStringsSHA256, "Go error table changed"); assert.equal(hash(linuxErrors), ESBUILD.linuxErrorStringsSHA256, "Linux Go error table changed");
assert.equal(hash(runtime), ESBUILD.goRuntimeSHA256, "Go Wasm runtime source changed");
const module = record(JSON.parse(go(["mod", "download", "-json", ESBUILD.module])) as unknown, "esbuild Go module");
assert.equal(module["Sum"], ESBUILD.moduleSum, "Authenticated esbuild source differs");
const source = string(module["Dir"], "esbuild module directory");
const bridge = await readFile(join(root, "scripts/esbuild/serve_bridge.go"));
const inputs = hash(Buffer.concat([bridge, Buffer.from(filesystem), Buffer.from(errors), Buffer.from(linuxErrors), runtime, Buffer.from(toolchainSHA256),
  await readFile(join(root, "scripts/esbuild/platform-patch.ts")), await readFile(import.meta.filename)]));
await mkdir(output, { recursive: true });
const target = join(output, "esbuild.wasm");
const receiptFile = join(cache, "compiler-build.json");
const receipt = await readFile(receiptFile, "utf8").then(value => record(JSON.parse(value) as unknown, "esbuild build receipt")).catch(() => undefined);
const previous = await readFile(target).catch(() => undefined);
if (receipt?.["inputsSHA256"] !== inputs || previous === undefined || receipt["wasmSHA256"] !== hash(previous)) {
  const build = join(cache, "source");
  await writableDirectories(build).catch((error: unknown) => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; });
  await rm(build, { recursive: true, force: true });
  await cp(source, build, { recursive: true, mode: 0 });
  await writableDirectories(build);
  async function patch(path: string, transform: (source: string) => string): Promise<void> {
    const file = join(build, path); await chmod(file, 0o644); await writeFile(file, transform(await readFile(file, "utf8")));
  }
  await patch("pkg/api/serve_other.go", source => source
    .replace("//go:build !js || !wasm", "//go:build !js || !wasm || oxidevm_esbuild")
    .replace("// +build !js !wasm", "// +build !js !wasm oxidevm_esbuild")
    .replaceAll("net.Listen(", "oxidevmListen(").replaceAll("net.InterfaceAddrs()", "oxidevmInterfaceAddrs()"));
  await patch("pkg/api/serve_wasm.go", source => source
    .replace("//go:build js && wasm", "//go:build js && wasm && !oxidevm_esbuild")
    .replace("// +build js,wasm", "// +build js,wasm,!oxidevm_esbuild"));
  await patch("cmd/esbuild/main_wasm.go", source => replaceOnce(source, "func isServeUnsupported() bool {\n\treturn true\n}", "func isServeUnsupported() bool {\n\treturn false\n}"));
  await writeFile(join(build, "pkg/api/serve_bridge.go"), bridge);
  const adapted = join(cache, "fs_js.go");
  await writeFile(adapted, patchGoFilesystem(filesystem));
  const errorOverlay = join(cache, "tables_js.go"), originalTable = /var errorstr = \[\.\.\.\]string\{[\s\S]*?\n\}/u.exec(errors)?.[0];
  const linuxTable = /var errors = \[\.\.\.\]string\{[\s\S]*?\n\}/u.exec(linuxErrors)?.[0];
  assert(originalTable !== undefined && linuxTable !== undefined, "Pinned Go error arrays are absent");
  await writeFile(errorOverlay, replaceOnce(replaceOnce(errors, 'import "runtime"', ""), originalTable, linuxTable.replace("var errors", "var errorstr")));
  const overlay = join(cache, "overlay.json");
  await writeFile(overlay, JSON.stringify({ Replace: { [join(goroot, "src/syscall/fs_js.go")]: adapted, [join(goroot, "src/syscall/tables_js.go")]: errorOverlay } }));
  go(["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-tags=oxidevm_esbuild", `-overlay=${overlay}`, "-ldflags=-s -w -buildid=", "-o", target, "./cmd/esbuild"], build, { GOOS: "js", GOARCH: "wasm" });
  await writeFile(receiptFile, `${JSON.stringify({ schemaVersion: 1, inputsSHA256: inputs, wasmSHA256: hash(await readFile(target)) }, null, 2)}\n`);
}
const wasm = await readFile(target), wasmSHA256 = hash(wasm);
if (process.argv.includes("--update-identity")) {
  const file = join(root, "packages/sdk/src/runtime/esbuild-identity.ts");
  const source = replaceOnce(await readFile(file, "utf8"), `wasmSHA256: "${ESBUILD.wasmSHA256}"`, `wasmSHA256: "${wasmSHA256}"`);
  await writeFile(file, replaceOnce(source, `wasmBytes: ${String(ESBUILD.wasmBytes)}`, `wasmBytes: ${String(wasm.length)}`));
} else { assert.equal(wasmSHA256, ESBUILD.wasmSHA256, "Rebuilt compiler differs from the qualified artifact"); assert.equal(wasm.length, ESBUILD.wasmBytes); }
const licenseFile = join(cache, "Go-LICENSE.txt");
const goLicense = await readFile(licenseFile, "utf8").catch(async () => fetch(`https://raw.githubusercontent.com/golang/go/${ESBUILD.goVersion}/LICENSE`).then(response => {
  if (!response.ok) throw new Error(`Go license download failed (${String(response.status)})`);
  return response.text();
}));
assert.equal(hash(goLicense), ESBUILD.goLicenseSHA256, "Go license changed");
const vendored = ["crypto", "net", "sys", "text"];
for (const name of vendored) assert.equal(hash(await readFile(join(goroot, "src/vendor/golang.org/x", name, "LICENSE"))), ESBUILD.goLicenseSHA256, `Go vendored ${name} license changed`);
await writeFile(licenseFile, goLicense);
await cp(join(source, "LICENSE.md"), join(output, "esbuild-LICENSE.txt"));
await writeFile(join(output, "Go-LICENSE.txt"), goLicense);
const notices = `/*! @license esbuild ${ESBUILD.version} (MIT)\n${await readFile(join(source, "LICENSE.md"), "utf8")}\nGo ${ESBUILD.goVersion} (BSD-3-Clause)\n${goLicense}\n*/\n`;
await bundleWorker({ entryPoints: [join(root, "packages/sdk/src/runtime/workers/esbuild/process.worker.ts")],
  outfile: join(output, "esbuild.worker.js"), bundle: true, platform: "browser", format: "esm", target: "esnext",
  banner: { js: notices + runtime.toString("utf8") }, legalComments: "inline" });
const workerPath = join(output, "esbuild.worker.js");
await writeFile(workerPath, await minifyJavaScript(await readFile(workerPath, "utf8"), false));
const goVendorModules = await readFile(join(goroot, "src/vendor/modules.txt"), "utf8");
const goVendoredVersions = vendored.map(name => { const module = `golang.org/x/${name}`, version = new RegExp(`^# ${module} ([^\\s]+)$`, "mu").exec(goVendorModules)?.[1]; assert(version !== undefined, `Missing Go vendored revision: ${module}`); return { name: module, version, license: "BSD-3-Clause" }; });
await writeFile(join(output, "esbuild.provenance.json"), `${JSON.stringify({ schemaVersion: 1, module: ESBUILD.module, sum: ESBUILD.moduleSum,
  goVersion: ESBUILD.goVersion, toolchainSHA256, inputsSHA256: inputs, wasmSHA256, bytes: wasm.length, goRuntimeSHA256: hash(runtime), goVendored: vendored.map(name => `golang.org/x/${name}`),
  goVendoredVersions, goVendorModulesSHA256: hash(goVendorModules),
  sourceInputs: { filesystemSHA256: hash(filesystem), errorStringsSHA256: hash(errors), linuxErrorStringsSHA256: hash(linuxErrors), listenerAdapterSHA256: hash(bridge), platformPatchSHA256: hash(await readFile(join(root, "scripts/esbuild/platform-patch.ts"))) },
  nativeSHA256: ESBUILD.nativeSHA256, workerSHA256: hash(await readFile(join(output, "esbuild.worker.js"))),
  platformPatch: "oxidevm-esbuild-linux-services-v1", licenses: [
    { id: "MIT", path: "esbuild-LICENSE.txt", sha256: hash(await readFile(join(output, "esbuild-LICENSE.txt"))) },
    { id: "BSD-3-Clause", path: "Go-LICENSE.txt", sha256: ESBUILD.goLicenseSHA256 },
  ] }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ target, wasmSHA256, bytes: wasm.length })}\n`);
