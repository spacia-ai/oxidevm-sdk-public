import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { Stats, statsOf } from "./node-stats.js";

const control = record(JSON.parse(readFileSync(new URL("./node-stats.controls.json", import.meta.url), "utf8")), "fs.Stats controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-stats.cjs", import.meta.url));
const describe = (target: object) => Object.getOwnPropertyNames(target).map(name => {
  const d = Object.getOwnPropertyDescriptor(target, name);
  if (d === undefined) throw new Error(`no ${name}`);
  return { name, kind: d.get === undefined ? typeof d.value : "accessor", setter: d.set !== undefined, enumerable: d.enumerable, writable: d.writable ?? null, configurable: d.configurable };
});
const make = (mode: number, atimeMs: number) => new Stats(2049, mode, 1, 1000, 1000, 0, 4096, 77, 12, 8, atimeMs, 1700000000000.9, 1700000000000.25, 0);
const read = (target: object, name: string): unknown => Reflect.get(target, name);
const iso = (value: unknown): string => { if (!(value instanceof Date)) throw new TypeError("not a date"); return value.toISOString(); };
const call = (target: object, name: string): unknown => { const method = read(target, name); if (typeof method !== "function") throw new TypeError(name); return Reflect.apply(method, target, []); };

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("has the shape, lazy dates and type tests of pinned Node's fs.Stats", () => {
  const stats = make(0o100644, 1700000000000.5);
  const prototype: unknown = Object.getPrototypeOf(stats), base: unknown = typeof prototype === "object" && prototype !== null ? Object.getPrototypeOf(prototype) : null;
  if (typeof prototype !== "object" || prototype === null || typeof base !== "object" || base === null) throw new TypeError("no prototype chain");
  expect({ own: describe(stats), prototype: describe(prototype), base: describe(base), length: Stats.length }).toEqual(control["shape"]);
  const keys = [Object.keys(stats)];
  const dates = { atime: iso(stats.atime), mtime: iso(stats.mtime), ctime: iso(stats.ctime), birthtime: iso(read(stats, "birthtime")) };
  keys.push(Object.keys(stats));
  const first = stats.atime;
  const cached = first === stats.atime;
  stats.atimeMs = 0;
  const assigned = make(0o100644, 1); Reflect.set(assigned, "mtime", "x");
  const types: Record<string, string[]> = {};
  for (const [label, mode] of [["file", 0o100644], ["directory", 0o040755], ["symlink", 0o120777], ["block", 0o060600], ["character", 0o020666], ["fifo", 0o010644], ["socket", 0o140755], ["none", 0]] as const) {
    const s = make(mode, 0);
    types[label] = ["isFile", "isDirectory", "isSymbolicLink", "isBlockDevice", "isCharacterDevice", "isFIFO", "isSocket"].filter(name => call(s, name) === true);
  }
  const borrowed = make(0o040755, 0); Reflect.set(borrowed, "_checkModeProperty", () => "checked");
  const json: unknown = JSON.parse(JSON.stringify(make(0o100644, 1.25)));
  expect({ keys, dates, cached, kept: iso(stats.atime), assigned: { value: read(assigned, "mtime"), keys: Object.keys(assigned) }, types,
    overridden: call(borrowed, "isDirectory"), json, instance: make(0, 0) instanceof Stats })
    .toEqual({ keys: control["keys"], dates: control["dates"], cached: control["cached"], kept: control["kept"], assigned: control["assigned"],
      types: control["types"], overridden: control["overridden"], json: control["json"], instance: control["instance"] });
});

it("keeps a reply without extended metadata free of rdev and birthtimeMs, as before", () => {
  const stats = statsOf({ dev: 1, mode: 0o100644, nlink: 1, uid: 0, gid: 0, rdev: undefined, blksize: 4096, ino: 2, size: 3, blocks: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: undefined });
  expect(Object.keys(stats)).toEqual(["dev", "mode", "nlink", "uid", "gid", "blksize", "ino", "size", "blocks", "atimeMs", "mtimeMs", "ctimeMs"]);
  expect(stats).toBeInstanceOf(Stats);
});
