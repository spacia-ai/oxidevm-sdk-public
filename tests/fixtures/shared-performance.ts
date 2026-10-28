import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

mkdirSync("shared-performance", { recursive: true });
const root = join(process.cwd(), "shared-performance"), require = createRequire(join(root, "fixture.cjs"));
writeFileSync(join(root, "loaded.cjs"), "module.exports = {answer: 42};");
const loaded: unknown = require("./loaded.cjs");
assert(typeof loaded === "object" && loaded !== null && "answer" in loaded && loaded.answer === 42);
let sum = 0;
const modulesAt = performance.now();
for (let index = 0; index < 4096; index++) {
  const value: unknown = require("./loaded.cjs"); assert.equal(value, loaded); sum += 42;
}
const modulesMs = performance.now() - modulesAt, bindingAt = performance.now();
const binding: unknown = require(require.resolve("@next/swc-linux-x64-musl", { paths: [require.resolve("next")] }));
assert(typeof binding === "object" && binding !== null);
const target: unknown = Reflect.get(binding, "getTargetTriple"); assert(typeof target === "function");
const bindingMs = performance.now() - bindingAt, framesAt = performance.now();
let triple: unknown;
for (let index = 0; index < 512; index++) {
  const actual: unknown = Reflect.apply(target, binding, []);
  assert(typeof actual === "string" && actual.includes("linux"));
  triple ??= actual; assert.equal(actual, triple);
}
const framesMs = performance.now() - framesAt;
const unchanged = Buffer.alloc(8 * 1024 ** 2, 17), unchangedPath = join(root, "compiler-cache.bin");
writeFileSync(unchangedPath, unchanged);
const initial = openSync(unchangedPath, "r+");
try { fsyncSync(initial); } finally { closeSync(initial); }
const persistenceAt = performance.now(), commits: number[] = [];
for (let index = 0; index < 8; index++) {
  const at = performance.now(), path = join(root, "changed.txt");
  writeFileSync(path, String(index));
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  commits.push(performance.now() - at);
}
const persistenceMs = performance.now() - persistenceAt;
assert.equal(readFileSync(join(root, "changed.txt"), "utf8"), "7");
const preserved = readFileSync(unchangedPath); assert.deepEqual(preserved, unchanged);
console.log(JSON.stringify({ result: { sum, triple, unchanged: createHash("sha256").update(preserved).digest("hex"), changed: "7" },
  timings: { modulesMs, bindingMs, framesMs, persistenceMs, commits } }));

// Keep the synchronous fixture alive until the host confirms its worker identity.
if (process.argv.includes("--inspect-exit")) process.stdin.resume();
