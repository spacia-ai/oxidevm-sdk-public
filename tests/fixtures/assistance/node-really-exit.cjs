"use strict";
// Records process.reallyExit and its use by process.exit on Node.js 24.18.1 for
// packages/sdk/src/runtime/workers/assistance/node-process.ts; its output is node-really-exit.controls.json.
// Run with the runtime row of the engine's spec/acceleration/artifacts.tsv, through its own musl loader:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-really-exit.cjs
// Every scenario runs in a child of the same binary; `log` writes one line to stdout. Through a loader, give the child
// command as JSON in NODE_COMMAND, for example ["<root>/lib/ld-musl-x86_64.so.1","--library-path","…","<root>/usr/bin/node"].
const { spawnSync } = require("node:child_process");
const log = "const log = (...v) => process.stdout.write(v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\\n');";
const scenarios = [
  ["descriptor", "const d = Object.getOwnPropertyDescriptor(process, 'reallyExit'); log(typeof d.value, d.enumerable, d.writable, d.configurable, process.reallyExit.name, process.reallyExit.length);"],
  ["exit-calls-patched", "const o = process.reallyExit; process.reallyExit = function (c) { log('patched', c, this === process, process.exitCode); o.call(process, c); }; process.on('exit', c => log('exit', c)); process.exit(3);"],
  ["direct-skips-exit-event", "process.on('exit', c => log('exit', c)); process.exitCode = 5; process.reallyExit(7); log('after');"],
  ["direct-no-argument", "process.on('exit', c => log('exit', c)); process.reallyExit();"],
  ["direct-string", "process.reallyExit('9');"],
  ["direct-wraps", "process.reallyExit(260);"],
  ["direct-negative", "process.reallyExit(-1);"],
  ["direct-fraction", "process.reallyExit(3.9);"],
  ["natural-end-skips-patched", "const o = process.reallyExit; process.reallyExit = function (c) { log('patched', c); o.call(process, c); }; process.on('exit', c => log('exit', c)); process.exitCode = 2;"],
  ["uncaught-skips-patched", "const o = process.reallyExit; process.reallyExit = function (c) { log('patched', c); o.call(process, c); }; process.on('exit', c => log('exit', c)); process.on('uncaughtException', () => { log('caught'); process.exitCode = 6; });  setTimeout(() => { throw new Error('boom'); }, 0);"],
  ["patched-returns", "process.reallyExit = function (c) { log('patched', c); }; process.on('exit', c => log('exit', c)); const value = process.exit(4); log('continued', typeof value); setTimeout(() => log('timer'), 0);"],
  ["exit-twice", "let n = 0; const o = process.reallyExit; process.reallyExit = function (c) { log('patched', c, ++n); if (n === 2) o.call(process, c); }; process.on('exit', c => log('exit', c)); process.exit(1); process.exit(8);"],
];
const rows = scenarios.map(([name, body]) => {
  const [command, ...prefix] = process.env.NODE_COMMAND === undefined ? [process.execPath] : JSON.parse(process.env.NODE_COMMAND);
  const child = spawnSync(command, [...prefix, "-e", `${log}\n${body}`], { encoding: "utf8", env: {} });
  return { name, body, stdout: child.stdout.split("\n").filter(line => line !== ""), status: child.status };
});
process.stdout.write(`${JSON.stringify({ rows }, null, 2)}\n`);
