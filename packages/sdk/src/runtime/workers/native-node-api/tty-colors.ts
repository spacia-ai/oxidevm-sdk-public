/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/tty.js (getColorDepth, hasColors) and
 * lib/internal/validators.js (validateInteger).
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
import { invalidArgType } from "../assistance/node-arg-type.js";

const COLORS_2 = 1, COLORS_16 = 4, COLORS_256 = 8, COLORS_16M = 24;
const TERM_ENVIRONMENTS: Readonly<Record<string, number>> = {
  eterm: COLORS_16, cons25: COLORS_16, console: COLORS_16, cygwin: COLORS_16, dtterm: COLORS_16, gnome: COLORS_16, hurd: COLORS_16,
  jfbterm: COLORS_16, konsole: COLORS_16, kterm: COLORS_16, mlterm: COLORS_16, mosh: COLORS_16M, putty: COLORS_16, st: COLORS_16,
  "rxvt-unicode-24bit": COLORS_16M, terminator: COLORS_16M, "xterm-kitty": COLORS_16M,
};
const CI_ENVIRONMENTS: readonly (readonly [string, number])[] = [
  ["APPVEYOR", COLORS_256], ["BUILDKITE", COLORS_256], ["CIRCLECI", COLORS_16M], ["DRONE", COLORS_256], ["GITEA_ACTIONS", COLORS_16M],
  ["GITHUB_ACTIONS", COLORS_16M], ["GITLAB_CI", COLORS_256], ["TRAVIS", COLORS_256],
];
const TERM_PATTERNS = [/ansi/u, /color/u, /linux/u, /direct/u, /^con[0-9]*x[0-9]/u, /^rxvt/u, /^screen/u, /^xterm/u, /^vt100/u, /^vt220/u];

/** The program's `process`, which the process runtime installs before any program code runs. */
interface ColorProcess { readonly env: object; emitWarning(message: string, type: string): void }
function programProcess(): ColorProcess {
  const value: unknown = Reflect.get(globalThis, "process");
  const env: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "env") : undefined;
  const emit: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "emitWarning") : undefined;
  if (typeof env !== "object" || env === null || typeof emit !== "function") throw new TypeError("The program's process is not installed");
  return { env, emitWarning: (message, type) => { Reflect.apply(emit, value, [message, type]); } };
}
/** A property read as Node's `env.NAME` does it: primitives read through their wrapper, null and undefined throw. */
function read(env: unknown, name: string): unknown {
  if (env === null || env === undefined) throw new TypeError(`Cannot read properties of ${String(env)} (reading '${name}')`);
  return Reflect.get(Object(env), name);
}
/** Node's template-literal and `===` comparisons see the value's string form. */
const stringify: (value: unknown) => string = String;
const text = (env: unknown, name: string): string | undefined => { const value = read(env, name); return value === undefined ? undefined : stringify(value); };
/** Node tests these variables for truthiness: set and not empty. */
const present = (value: string | undefined): value is string => value !== undefined && value !== "";
/** Node's `name in env`, which throws for a primitive. */
function has(env: unknown, name: string): boolean {
  if (typeof env !== "object" && typeof env !== "function" || env === null) throw new TypeError(`Cannot use 'in' operator to search for '${name}' in ${String(env)}`);
  return name in env;
}

/** Node's color support: `getColorDepth` and `hasColors` of `tty.WriteStream.prototype`, as pinned Node has them. */
export function createColorSupport(inspect: (value: unknown, options: { readonly depth: -1 }) => string) {
  let warned = false;
  function warnOnDeactivatedColors(env: unknown): void {
    if (warned) return;
    let name = "";
    if (read(env, "NODE_DISABLE_COLORS") !== undefined) name = "NODE_DISABLE_COLORS";
    if (read(env, "NO_COLOR") !== undefined) { if (name !== "") name += "' and '"; name += "NO_COLOR"; }
    if (name !== "") { programProcess().emitWarning(`The '${name}' env is ignored due to the 'FORCE_COLOR' env being set.`, "Warning"); warned = true; }
  }
  function getColorDepth(this: unknown, env: unknown = programProcess().env): number {
    const force = text(env, "FORCE_COLOR");
    if (force !== undefined) {
      switch (force) {
        case "": case "1": case "true": warnOnDeactivatedColors(env); return COLORS_16;
        case "2": warnOnDeactivatedColors(env); return COLORS_256;
        case "3": warnOnDeactivatedColors(env); return COLORS_16M;
        default: return COLORS_2;
      }
    }
    const term = text(env, "TERM");
    if (read(env, "NODE_DISABLE_COLORS") !== undefined || read(env, "NO_COLOR") !== undefined || term === "dumb") return COLORS_2;
    if (present(text(env, "TMUX"))) return COLORS_16M;
    if (present(text(env, "CI"))) {
      for (const [name, colors] of CI_ENVIRONMENTS) if (has(env, name)) return colors;
      return text(env, "CI_NAME") === "codeship" ? COLORS_256 : COLORS_2;
    }
    if (has(env, "TEAMCITY_VERSION")) return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/u.test(text(env, "TEAMCITY_VERSION") ?? "") ? COLORS_16 : COLORS_2;
    switch (text(env, "TERM_PROGRAM")) {
      case "iTerm.app": { const version = text(env, "TERM_PROGRAM_VERSION"); return !present(version) || /^[0-2]\./u.test(version) ? COLORS_256 : COLORS_16M; }
      case "HyperTerm": case "MacTerm": return COLORS_16M;
      case "Apple_Terminal": return COLORS_256;
      case undefined: default: break;
    }
    const colorTerm = text(env, "COLORTERM");
    if (colorTerm === "truecolor" || colorTerm === "24bit") return COLORS_16M;
    if (present(term)) {
      if (/truecolor/u.test(term)) return COLORS_16M;
      if (/^xterm-256/u.test(term)) return COLORS_256;
      const lower = term.toLowerCase();
      const known = TERM_ENVIRONMENTS[lower];
      if (known !== undefined) return known;
      if (TERM_PATTERNS.some(pattern => pattern.test(lower))) return COLORS_16;
    }
    return present(colorTerm) ? COLORS_16 : COLORS_2;
  }
  function hasColors(this: unknown, count?: unknown, env?: unknown): boolean {
    if (env === undefined && (count === undefined || (typeof count === "object" && count !== null))) {
      return 16 <= 2 ** (count === undefined ? getColorDepth() : getColorDepth(count));
    }
    if (typeof count !== "number") throw invalidArgType("count", "number", count, inspect);
    if (!Number.isInteger(count)) throw outOfRange("count", "an integer", count);
    if (count < 2 || count > Number.MAX_SAFE_INTEGER) throw outOfRange("count", `>= 2 && <= ${String(Number.MAX_SAFE_INTEGER)}`, count);
    return count <= 2 ** (env === undefined ? getColorDepth() : getColorDepth(env));
  }
  return { getColorDepth, hasColors };
}

function outOfRange(name: string, range: string, value: number): RangeError {
  return Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`), { code: "ERR_OUT_OF_RANGE" });
}
