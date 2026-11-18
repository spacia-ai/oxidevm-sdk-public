"use strict";
// Records the shape of Node.js 24.18.1's fs.Stats for packages/sdk/src/runtime/workers/assistance/node-stats.ts;
// its output is node-stats.controls.json. Run with the runtime row of the engine's spec/acceleration/artifacts.tsv:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-stats.cjs
const { Stats } = require("node:fs");
const describe = target => Object.getOwnPropertyNames(target).map(name => {
  const d = Object.getOwnPropertyDescriptor(target, name);
  return { name, kind: d.get === undefined ? typeof d.value : "accessor", setter: d.set !== undefined, enumerable: d.enumerable, writable: d.writable ?? null, configurable: d.configurable };
});
process.noDeprecation = true;
const make = (mode, atimeMs) => new Stats(2049, mode, 1, 1000, 1000, 0, 4096, 77, 12, 8, atimeMs, 1700000000000.9, 1700000000000.25, 0);
const stats = make(0o100644, 1700000000000.5);
const shape = { own: describe(stats), prototype: describe(Object.getPrototypeOf(stats)), base: describe(Object.getPrototypeOf(Object.getPrototypeOf(stats))), length: Stats.prototype.constructor.length };
const keys = [Object.keys(stats)];
const dates = { atime: stats.atime.toISOString(), mtime: stats.mtime.toISOString(), ctime: stats.ctime.toISOString(), birthtime: stats.birthtime.toISOString() };
keys.push(Object.keys(stats));
const cached = stats.atime === stats.atime;
stats.atimeMs = 0;
const kept = stats.atime.toISOString();
const assigned = make(0o100644, 1); assigned.mtime = "x";
const types = {};
for (const [label, mode] of [["file", 0o100644], ["directory", 0o040755], ["symlink", 0o120777], ["block", 0o060600], ["character", 0o020666], ["fifo", 0o010644], ["socket", 0o140755], ["none", 0]]) {
  const s = make(mode, 0);
  types[label] = ["isFile", "isDirectory", "isSymbolicLink", "isBlockDevice", "isCharacterDevice", "isFIFO", "isSocket"].filter(name => s[name]());
}
const borrowed = make(0o040755, 0); borrowed._checkModeProperty = () => "checked";
const json = JSON.parse(JSON.stringify(make(0o100644, 1.25)));
process.stdout.write(`${JSON.stringify({ shape, keys, dates, cached, kept, assigned: { value: assigned.mtime, keys: Object.keys(assigned) }, types,
  overridden: borrowed.isDirectory(), json, instance: make(0, 0) instanceof Stats }, null, 2)}\n`);
