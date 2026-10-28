import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { record, string } from "../packages/sdk/src/runtime/decode.ts";
import { isEntryPoint } from "./entry-point.ts";
import { packedArchives } from "./packed-archives.ts";
import { scanSecrets } from "./secret-scan.ts";
import { repositoryContentError } from "./repository-layout.ts";

function compilerWasm(path: string): "esbuild" | "swc" | undefined {
  if (path === "package/assets/compilers/esbuild.wasm" || /^package\/assets\/(?:qualification|runtime-host|snapshot)\/assets\/esbuild-[A-Za-z0-9_-]{8}\.wasm$/u.test(path)) return "esbuild";
  if (/^package\/assets\/native-process\/assets\/wasm_bg-[A-Za-z0-9_-]{8}\.wasm$/u.test(path)) return "swc";
  return undefined;
}

export function validateReleaseArchive(value: unknown, paths: readonly string[], name: string, version: string, target: "private-preview" | "public" = "private-preview"): void {
  const manifest = record(value, "packed manifest");
  if (manifest["name"] !== name || manifest["version"] !== version || manifest["private"] !== (target === "private-preview")) throw new Error("Archive identity or private flag differs from the release target");
  if (target === "private-preview") { if (manifest["publishConfig"] !== undefined) throw new Error("Private archive must not carry registry publishing configuration"); }
  else {
    const publishing = record(manifest["publishConfig"], "public registry policy");
    if (Object.keys(publishing).length !== 2 || publishing["registry"] !== "https://registry.npmjs.org/" || publishing["access"] !== "public") throw new Error("Public archive registry policy differs from the approved public target");
  }
  const dependencies = record(manifest["dependencies"] ?? {}, "packed dependencies");
  for (const dependency of Object.values(dependencies)) if (/^(?:workspace|file|link):/u.test(string(dependency, "dependency"))) throw new Error("Archive contains a workspace or local dependency");
  if (name === "@oxidevm/cli" && dependencies["@oxidevm/sdk"] !== version) throw new Error("CLI must depend on the exact matching SDK version");
  for (const path of paths) {
    if (!path.startsWith("package/") || path.split("/").some(part => part === ".." || part.startsWith(".env") || [".git", "node_modules", "src", "rootfs", "images"].includes(part)) || path.includes("\\") || /(?:oxidevm_(?:core|userspace|netstack)|\.(?:pem|key|img|qcow2|oxvm|tgz)$)/iu.test(path)) throw new Error(`Forbidden archive entry: ${path}`);
    if (path.endsWith(".wasm") && compilerWasm(path) === undefined) throw new Error(`Unexpected compiler Wasm: ${path}`);
  }
  for (const path of ["package/LICENSE", "package/NOTICE", `package/dist/${name === "@oxidevm/sdk" ? "index" : "bin"}.js`]) if (!paths.includes(path)) throw new Error(`Archive lacks ${path}`);
}

function run(root: string, command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 ** 2, timeout: 15 * 60_000 });
}

/** Fresh consumers install the actual archives with a transitive SDK override, without a private registry. */
export async function verifyReleaseArchives(root: string, target: "private-preview" | "public" = "private-preview"): Promise<void> {
  await mkdir(join(root, ".candidate"), { recursive: true });
  for (const name of ["@oxidevm/sdk", "@oxidevm/cli"]) run(root, "pnpm", ["--filter", name, "pack", "--pack-destination", join(root, ".candidate")]);
  const archives = await packedArchives(root);
  const source: unknown = JSON.parse(await readFile(join(root, "packages/sdk/package.json"), "utf8"));
  const version = string(record(source, "SDK package")["version"], "SDK version");
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const compilers = { esbuild: digest(await readFile(join(root, "packages/sdk/assets/compilers/esbuild.wasm"))), swc: digest(await readFile(join(root, "packages/sdk/node_modules/@swc/wasm-web/wasm_bg.wasm"))) };
  for (const [name, file] of [["@oxidevm/sdk", archives.sdk], ["@oxidevm/cli", archives.cli]] as const) {
    const paths = run(root, "tar", ["-tzf", file]).trim().split("\n");
    const manifest: unknown = JSON.parse(run(root, "tar", ["-xzOf", file, "package/package.json"]));
    validateReleaseArchive(manifest, paths, name, version, target);
    const unpacked = await mkdtemp(join(tmpdir(), "oxidevm-packed-scan-"));
    run(root, "tar", ["-xzf", file, "-C", unpacked, "--no-same-owner"]);
    for (const path of paths) {
      const bytes = await readFile(join(unpacked, path)), compiler = compilerWasm(path);
      if (compiler !== undefined) assert.equal(digest(bytes), compilers[compiler], `${path} differs from its required compiler input`);
      // The compiled native-process module includes the pinned TypeScript libraries (about 24 MB).
      else if (repositoryContentError(bytes, 64 * 1024 ** 2) !== undefined) throw new Error(`Unexpected binary in package archive: ${path}`);
    }
    await scanSecrets(unpacked, "dir", root);
  }
  const consumer = await mkdtemp(join(tmpdir(), "oxidevm-archive-consumer-"));
  // Retain this disposable consumer on failure so its installation and compiler output remain inspectable.
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "archive-consumer", private: true, type: "module", dependencies: { "@oxidevm/sdk": `file:${archives.sdk}`, "@oxidevm/cli": `file:${archives.cli}` }, devDependencies: { typescript: "6.0.3", "@types/node": "24.13.3", vite: "7.3.6", "@xterm/xterm": "6.0.0", "@xterm/addon-fit": "0.11.0" } }));
  await writeFile(join(consumer, "pnpm-workspace.yaml"), `packages:\n  - examples/*\noverrides:\n  '@oxidevm/sdk': ${JSON.stringify(`file:${archives.sdk}`)}\nallowBuilds:\n  esbuild: true\n`);
  await cp(join(root, "examples"), join(consumer, "examples"), { recursive: true, filter: path => !path.split("/").some(part => ["node_modules", "dist", ".cache"].includes(part)) && !path.includes("/public/oxidevm/") && !path.endsWith("/public/oxidevm") });
  await cp(join(root, "tsconfig.base.json"), join(consumer, "tsconfig.base.json"));
  await cp(join(root, "types"), join(consumer, "types"), { recursive: true });
  await mkdir(join(consumer, "scripts"));
  await cp(join(root, "scripts/license-expression.ts"), join(consumer, "scripts/license-expression.ts"));
  run(consumer, "pnpm", ["install", "--no-frozen-lockfile"]);
  run(consumer, "pnpm", ["install", "--frozen-lockfile"]);
  await writeFile(join(consumer, "consumer.ts"), 'import { createVM, defineImage, defaultImage } from "@oxidevm/sdk";\nimport type { VM } from "@oxidevm/sdk";\nimport * as machine from "@oxidevm/sdk/machine";\nimport * as diagnostics from "@oxidevm/sdk/diagnostics";\nimport * as js from "@oxidevm/sdk/js-process";\nimport { getSDKRelease, buildImage } from "@oxidevm/sdk/image-builder";\nexport const api = { createVM, defineImage, defaultImage, machine, diagnostics, js, getSDKRelease, buildImage };\nexport type ConsumerVM = VM;\n');
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2024", "DOM", "DOM.Iterable"], types: ["node"], strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false }, files: ["consumer.ts"] }));
  run(consumer, "pnpm", ["exec", "tsc", "-p", "tsconfig.json"]);
  await writeFile(join(consumer, "verify.mjs"), `import assert from 'node:assert/strict';\nimport { readFile, mkdir } from 'node:fs/promises';\nimport { createRequire } from 'node:module';\nimport { buildImage, generateImageKey, getSDKRelease } from '@oxidevm/sdk/image-builder';\nimport { defaultImage } from '@oxidevm/sdk';\nimport '@oxidevm/sdk/machine';\nimport '@oxidevm/sdk/diagnostics';\nimport '@oxidevm/sdk/js-process';\nassert.equal(getSDKRelease().sdkVersion, ${JSON.stringify(version)});\nconst cli = createRequire(import.meta.resolve('@oxidevm/cli'));\nassert.equal(cli.resolve('@oxidevm/sdk'), import.meta.resolve('@oxidevm/sdk').replace('file://', ''));\nassert.throws(() => defaultImage('userspace'), error => error.code === 'FEATURE_NOT_AVAILABLE');\nawait mkdir('rootfs');\nconst key = await generateImageKey('author.pem');\nconst built = await buildImage({ mode: 'userspace', id: 'archive-fixture', version: '1', source: {kind:'directory',path:'rootfs'}, smokeTest:{command:'/bin/true',expectedExitCode:0} }, {recipeDir:process.cwd(),signingKeyFile:key.privateKeyPath});\nconst { execFileSync } = await import('node:child_process');\nconst out = execFileSync('pnpm',['exec','oxidevm','init','app','--mode','userspace','--image',built.bundleDir,'--image-trust',key.publicKeyPath,'--skip-assets'],{encoding:'utf8'});\nassert.ok(out.length > 0);\nconst lock = JSON.parse(await readFile('app/oxidevm.lock.json','utf8'));\nassert.equal(lock.sdkVersion, ${JSON.stringify(version)});\nassert.equal(lock.image.manifestSHA256,built.image.manifestSHA256);\n`);
  run(consumer, "node", ["verify.mjs"]);
  assert.match(run(consumer, "pnpm", ["exec", "oxidevm", "--version"]), new RegExp(version.replaceAll(".", "\\."), "u"));
  run(consumer, "pnpm", ["-r", "check"]);
  run(consumer, "pnpm", ["-r", "build"]);
  process.stdout.write(`Verified SDK and CLI ${version}, external declarations, CLI image initialization, frozen installation and example builds in ${consumer}\n`);
}

if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--target" || args[1] !== "public")) throw new Error("usage: node scripts/verify-release-archives.ts [--target public]");
  await verifyReleaseArchives(resolve(import.meta.dirname, ".."), args.length === 0 ? "private-preview" : "public");
}
