"use strict";
// Records libuv's error names and messages as Node.js 24.18.1 exposes them, for
// packages/sdk/src/runtime/workers/assistance/node-system-errors.ts; its output is node-system-errors.controls.json.
// Run with the runtime row of the engine's spec/acceleration/artifacts.tsv, through its own musl loader:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-system-errors.cjs
const fs = require("node:fs");
const { getSystemErrorMap } = require("node:util");
const errors = [...getSystemErrorMap()].sort((a, b) => b[0] - a[0]).map(([errno, [code, message]]) => ({ errno, code, message }));
const messages = [];
for (const run of [() => fs.openSync("/nonexistent"), () => fs.renameSync("/nonexistent", "/nonexistent-2"), () => fs.readdirSync("/nonexistent"), () => fs.mkdirSync("/")]) {
  try { run(); } catch (error) { messages.push({ code: error.code, syscall: error.syscall, path: error.path ?? null, dest: error.dest ?? null, message: error.message }); }
}
process.stdout.write(`${JSON.stringify({ errors, messages }, null, 2)}\n`);
