import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

async function main(): Promise<void> {
const started = performance.now();
const source = (index: number, change = 0) => Array.from({ length: 128 }, (_, value) =>
  `export const value${String(value)}: number = ${String(index + value + change)};`).join("\n");
mkdirSync("esbuild-performance/src", { recursive: true });
process.chdir("esbuild-performance");
for (let index = 0; index < 64; index++) writeFileSync(`src/module${String(index)}.ts`, source(index));
writeFileSync("src/entry.ts", Array.from({ length: 64 }, (_, index) => `import {value0 as value${String(index)}} from './module${String(index)}';`).join("\n")
  + `\nimport {marker} from 'virtual:marker'; console.log(marker, ${Array.from({ length: 64 }, (_, index) => `value${String(index)}`).join("+")});`);
const transformAt = performance.now();
const transformed = await esbuild.transform(source(1), { loader: "ts", minify: true, target: "es2020", sourcemap: "external" });
const transformMs = performance.now() - transformAt;
let callbacks = 0;
const options: esbuild.BuildOptions = { absWorkingDir: process.cwd(), entryPoints: ["src/entry.ts"], bundle: true, outfile: "dist/output.js", format: "cjs", minify: true, logLevel: "silent", tsconfigRaw: { compilerOptions: { alwaysStrict: true } },
  plugins: [{ name: "original-parent-plugin", setup(build) {
    build.onResolve({ filter: /^virtual:/ }, args => { callbacks++; return { path: args.path, namespace: "fixture" }; });
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => { callbacks++; return { contents: "export const marker = 'original-plugin';", loader: "js" }; });
  } }] };
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const outputs: string[] = [];
let context: esbuild.BuildContext | undefined;
try {
  const buildAt = performance.now();
  await esbuild.build(options); outputs.push(hash(readFileSync("dist/output.js")));
  const buildMs = performance.now() - buildAt, contextAt = performance.now();
  context = await esbuild.context(options);
  await context.rebuild(); outputs.push(hash(readFileSync("dist/output.js")));
  const contextMs = performance.now() - contextAt, incremental: number[] = [];
  for (let change = 1; change <= 3; change++) {
    const at = performance.now();
    writeFileSync("src/module0.ts", source(0, change));
    await context.rebuild(); incremental.push(performance.now() - at);
    outputs.push(hash(readFileSync("dist/output.js")));
  }
  assert.equal(outputs[0], outputs[1]);
  assert.equal(new Set(outputs.slice(1)).size, 4);
  assert.equal(callbacks, 10);
  await context.dispose(); context = undefined; await esbuild.stop();
  console.log(JSON.stringify({ result: { outputs, output: readFileSync("dist/output.js", "utf8"), callbacks, transform: hash(transformed.code), map: hash(transformed.map), version: esbuild.version },
    timings: { transformMs, buildMs, contextMs, incremental, totalMs: performance.now() - started } }));
  // Keep the fixture alive until the host confirms its worker identity.
  if (process.argv.includes("--inspect-exit")) process.stdin.resume();
} finally { await context?.dispose(); await esbuild.stop(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
