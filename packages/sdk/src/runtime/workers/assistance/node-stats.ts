/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/fs/utils.js (StatsBase, Stats, the lazy date fields).
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

const S_IFMT = 0o170000;
const TYPES = [
  ["isDirectory", 0o040000], ["isFile", 0o100000], ["isBlockDevice", 0o060000], ["isCharacterDevice", 0o020000],
  ["isSymbolicLink", 0o120000], ["isFIFO", 0o010000], ["isSocket", 0o140000],
] as const;

/** The fields of a Linux stat reply that Node's `Stats` holds, in its constructor's order. */
export interface StatFields {
  readonly dev: number; readonly mode: number; readonly nlink: number; readonly uid: number; readonly gid: number;
  readonly rdev: number | undefined; readonly blksize: number; readonly ino: number; readonly size: number; readonly blocks: number;
  readonly atimeMs: number; readonly mtimeMs: number; readonly ctimeMs: number; readonly birthtimeMs: number | undefined;
}

/** Node's `StatsBase`: the ten integer fields and the type tests, which read `_checkModeProperty`. */
class StatsBase {
  // Defined on the prototype below, as Node defines them.
  declare isDirectory: () => boolean; declare isFile: () => boolean; declare isBlockDevice: () => boolean; declare isCharacterDevice: () => boolean;
  declare isSymbolicLink: () => boolean; declare isFIFO: () => boolean; declare isSocket: () => boolean;
  dev: number; mode: number; nlink: number; uid: number; gid: number; rdev: number | undefined; blksize: number; ino: number; size: number; blocks: number;
  constructor(dev: number, mode: number, nlink: number, uid: number, gid: number, rdev: number | undefined, blksize: number, ino: number, size: number, blocks: number) {
    this.dev = dev; this.mode = mode; this.nlink = nlink; this.uid = uid; this.gid = gid;
    this.rdev = rdev; this.blksize = blksize; this.ino = ino; this.size = size; this.blocks = blocks;
  }
}
for (const [name, type] of TYPES) {
  Object.defineProperty(StatsBase.prototype, name, { value: function isType(this: unknown): unknown {
    const check: unknown = typeof this === "object" && this !== null ? Reflect.get(this, "_checkModeProperty") : undefined;
    if (typeof check !== "function") throw new TypeError("this._checkModeProperty is not a function");
    return Reflect.apply(check, this, [type]);
  }, enumerable: true, writable: true, configurable: true });
}

/** Node's `Stats`. The types are what the layer passes; programs calling the exported constructor may pass anything,
 * which is stored as given, as in Node. Node declares it with fourteen parameters; the class syntax keeps `new` mandatory, which Node's
 * exported, deprecated wrapper does not need: it calls the constructor through `Reflect.construct`. */
export class Stats extends StatsBase {
  atimeMs: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number | undefined;
  // Lazy fields on the prototype, below.
  declare atime: Date; declare mtime: Date; declare ctime: Date; declare birthtime: Date;
  constructor(dev: number, mode: number, nlink: number, uid: number, gid: number, rdev: number | undefined, blksize: number, ino: number, size: number, blocks: number,
    atimeMs: number, mtimeMs: number, ctimeMs: number, birthtimeMs: number | undefined) {
    super(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks);
    this.atimeMs = atimeMs; this.mtimeMs = mtimeMs; this.ctimeMs = ctimeMs; this.birthtimeMs = birthtimeMs;
  }
}
const ownValue = (target: object, name: string, value: unknown): void => {
  Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
};
// Each date is made from its millisecond field on first read and then kept as the object's own property, as an
// assignment is; Node's `dateFromMs` rounds to a whole millisecond.
for (const name of ["atime", "mtime", "ctime", "birthtime"] as const) {
  Object.defineProperty(Stats.prototype, name, {
    get(this: object): Date { const value = new Date(Math.round(Number(Reflect.get(this, `${name}Ms`)))); ownValue(this, name, value); return value; },
    set(this: object, value: unknown): void { ownValue(this, name, value); },
    enumerable: true, configurable: true,
  });
}
Object.defineProperty(Stats.prototype, "_checkModeProperty", { value: function _checkModeProperty(this: unknown, property: unknown): boolean {
  const mode: unknown = typeof this === "object" && this !== null ? Reflect.get(this, "mode") : undefined;
  return (Number(mode) & S_IFMT) === property;
}, enumerable: true, writable: true, configurable: true });

/** A Linux stat reply as Node's `fs.statSync` returns it. A reply from a host without the extended metadata has no
 * `rdev` or `birthtimeMs`, as before; Node itself always has both. */
export function statsOf(fields: StatFields): Stats {
  const stats = new Stats(fields.dev, fields.mode, fields.nlink, fields.uid, fields.gid, fields.rdev, fields.blksize, fields.ino, fields.size, fields.blocks,
    fields.atimeMs, fields.mtimeMs, fields.ctimeMs, fields.birthtimeMs);
  if (fields.rdev === undefined) Reflect.deleteProperty(stats, "rdev");
  if (fields.birthtimeMs === undefined) Reflect.deleteProperty(stats, "birthtimeMs");
  return stats;
}
