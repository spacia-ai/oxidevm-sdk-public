// Build the pinned real TypeScript CLI as a trusted worker; project JavaScript is never evaluated.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { TYPESCRIPT } from "../packages/sdk/src/runtime/command-interceptor-identity.ts";
import { minifyJavaScript } from "./production-javascript.ts";

const packaged = process.argv.includes("--package");
const packageRoot = resolve(import.meta.dirname, "..");
const compilerRoot = dirname(createRequire(import.meta.url).resolve("typescript-interceptor/package.json"));
const source = packaged ? resolve(compilerRoot, "lib/_tsc.js") : resolve(process.argv[2] ?? `../oxidevm/.cache/guest/userspace-shell/output/blobs/${TYPESCRIPT.files.compiler.sha256}`);
const target = packaged ? resolve(packageRoot, "packages/sdk/assets/interceptors/tsc.worker.js") : resolve(process.argv[3] ?? ".cache/command-interceptors/tsc.worker.js");
const cli = await readFile(source, "utf8");
const licenseHash = TYPESCRIPT.licenseSHA256;
const license = await readFile(packaged ? resolve(compilerRoot, "LICENSE.txt") : resolve(dirname(source), licenseHash));
assert.equal(createHash("sha256").update(license).digest("hex"), licenseHash, "Compiler license identity changed");
assert.equal(createHash("sha256").update(cli).digest("hex"), TYPESCRIPT.files.compiler.sha256, "TypeScript 6.0.2 CLI source identity changed");
const start = cli.indexOf("var sys = (() => {");
const end = cli.indexOf("})();\nif (sys && sys.getEnvironmentVariable)", start);
assert(start >= 0 && end > start && cli.indexOf("var sys = (() => {", start + 1) < 0, "Pinned CLI System adapter boundary changed");
const adapted = cli.slice(0, start) + `var sys = system;
sys.readDirectory = (path, extensions, excludes, includes, depth) => matchFiles(path, extensions, excludes, includes, sys.useCaseSensitiveFileNames, sys.getCurrentDirectory(), depth, path => sys.getFileSystemEntries(path), path => sys.realpath(path));
patchWriteFileEnsuringDirectory(sys);
` + cli.slice(end + 5);
await mkdir(dirname(target), { recursive: true });
const worker = `/*! Modified for OxideVM: replace the pinned TypeScript System initializer with the Linux filesystem bridge. See the accompanying provenance JSON. */\nimport { serveTypeScript } from '/bundle/tsc-adapter.js';\nserveTypeScript(system => {\n${adapted}\n});\n`;
if (packaged) {
  await build({ stdin: { contents: worker.replace("/bundle/tsc-adapter.js", resolve(packageRoot, "packages/sdk/src/runtime/workers/command-interceptors/worker-system.ts")), resolveDir: packageRoot, sourcefile: "typescript-worker.js" }, outfile: target, bundle: true, minify: true, sourcemap: false, platform: "browser", format: "esm", target: "esnext", legalComments: "inline" });
  await writeFile(target, await minifyJavaScript(await readFile(target, "utf8"), false));
} else await writeFile(target, worker);
await writeFile(resolve(dirname(target), "TypeScript-LICENSE.txt"), license);
await writeFile(`${target}.provenance.json`, JSON.stringify({ sourceSHA256: TYPESCRIPT.files.compiler.sha256, version: TYPESCRIPT.version, compilerFiles: TYPESCRIPT.files, licenseSHA256: licenseHash, license: "Apache-2.0", transform: "replace-pinned-System-initializer-v2-linux-bridge", workerSHA256: createHash("sha256").update(await readFile(target)).digest("hex") }, null, 2) + "\n");
process.stdout.write(`${target}\n`);
