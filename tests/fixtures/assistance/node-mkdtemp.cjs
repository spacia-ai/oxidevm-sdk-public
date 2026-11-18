"use strict";
// Records fs.mkdtempSync, fs.mkdtemp and fs.promises.mkdtemp on Node.js 24.18.1 (musl) for
// packages/sdk/src/runtime/workers/assistance/node-file-mkdtemp.ts; its output is node-mkdtemp.controls.json.
// Run with the runtime row of the engine's spec/acceleration/artifacts.tsv, in an empty writable directory:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-mkdtemp.cjs
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const root = fs.mkdtempSync(`${process.cwd()}/record-`);
const relative = p => typeof p === "string" ? p.split(root).join("<root>") : p;
const outcome = run => {
  try {
    const value = run();
    if (Buffer.isBuffer(value)) return { buffer: relative(value.toString()).replace(/[A-Pa-p]{6}$/u, "<name>") };
    if (typeof value === "object" && value !== null) return value;
    if (typeof value !== "string") return { value: typeof value };
    const stat = fs.statSync(value);
    return { path: relative(value).replace(/[A-Pa-p]{6}$/u, "<name>"), suffixMatches: /[A-Pa-p]{6}$/u.test(value), mode: (stat.mode & 0o7777).toString(8), directory: stat.isDirectory() };
  } catch (error) {
    return { error: { name: error.name, code: error.code ?? null, errno: error.errno ?? null, syscall: error.syscall ?? null, path: relative(error.path ?? null), message: relative(error.message) } };
  }
};
fs.writeFileSync(`${root}/file`, "");
process.umask(0o022);
const cases = [
  ["string", () => fs.mkdtempSync(`${root}/a-`)],
  ["no-dash", () => fs.mkdtempSync(`${root}/b`)],
  ["directory-prefix", () => fs.mkdtempSync(`${root}/`)],
  ["buffer-prefix", () => fs.mkdtempSync(Buffer.from(`${root}/c-`))],
  ["url-prefix", () => fs.mkdtempSync(pathToFileURL(`${root}/d-`))],
  ["encoding-buffer", () => fs.mkdtempSync(`${root}/e-`, "buffer")],
  ["encoding-option-buffer", () => fs.mkdtempSync(`${root}/f-`, { encoding: "buffer" })],
  ["encoding-utf8", () => fs.mkdtempSync(`${root}/g-`, { encoding: "utf8" })],
  ["encoding-invalid", () => fs.mkdtempSync(`${root}/h-`, { encoding: "nope" })],
  ["missing-parent", () => fs.mkdtempSync(`${root}/none/x-`)],
  ["parent-is-file", () => fs.mkdtempSync(`${root}/file/x-`)],
  ["number-prefix", () => fs.mkdtempSync(1)],
  ["undefined-prefix", () => fs.mkdtempSync()],
  ["null-byte", () => fs.mkdtempSync(`${root}/\u0000x`)],
  ["relative", () => { process.chdir(root); try { const name = fs.mkdtempSync("rel-"); return { relativeName: /^rel-[A-Pa-p]{6}$/u.test(name), directory: fs.statSync(name).isDirectory() }; } finally { process.chdir(`${root}/..`); } }],
];
const rows = cases.map(([name, run]) => ({ name, ...outcome(run) }));
const callback = new Promise(resolve => fs.mkdtemp(`${root}/cb-`, (error, value) => resolve(error === null ? outcome(() => value) : { error: { code: error.code, syscall: error.syscall, path: relative(error.path), message: relative(error.message) } })));
const callbackMissing = new Promise(resolve => fs.mkdtemp(`${root}/none/cb-`, error => resolve({ error: { code: error.code, errno: error.errno, syscall: error.syscall, path: relative(error.path), message: relative(error.message) } })));
const noCallback = outcome(() => fs.mkdtemp(`${root}/nc-`));
Promise.all([callback, callbackMissing, fs.promises.mkdtemp(`${root}/p-`).then(value => outcome(() => value)),
  fs.promises.mkdtemp(`${root}/none/p-`).catch(error => ({ error: { code: error.code, errno: error.errno, syscall: error.syscall, path: relative(error.path), message: relative(error.message) } })),
]).then(([cb, cbMissing, promise, promiseMissing]) => {
  fs.rmSync(root, { recursive: true });
  process.stdout.write(`${JSON.stringify({ rows, callback: cb, callbackMissing: cbMissing, noCallback, promise, promiseMissing, lengths: [fs.mkdtempSync.length, fs.mkdtemp.length, fs.promises.mkdtemp.length] }, null, 2)}\n`);
});
