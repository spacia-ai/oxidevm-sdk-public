import { nodeUtil } from "./node-util.js";

const isInteger = Number.isInteger, parseOctal = Number.parseInt, inspect = nodeUtil.inspect;
const get = Reflect.get, assign = Object.assign;
const MaskTypeError = TypeError, MaskRangeError = RangeError;
const nonOctalDigit = /[^0-7]/u, bunOctal = /^[\t\n\v\f\r ]*\+?[0-7]+[\t\n\v\f\r ]*$/u;
const findNonOctalDigit = nonOctalDigit.exec.bind(nonOctalDigit), matchBunOctal = bunOctal.exec.bind(bunOctal);

/** Linux owns the shared filesystem context. Node and Bun differ at the JS boundary. */
export function createProcessUmask(call: (mask?: number) => number, runtime: "node" | "bun", isMainThread: boolean) {
  return function umask(mask?: unknown): number {
    if (mask === undefined) return call(undefined);
    if (runtime === "node" && !isMainThread) throw assign(new MaskTypeError("Setting process.umask() is not supported in workers"), { code: "ERR_WORKER_UNSUPPORTED_OPERATION" });
    if (typeof mask === "string") {
      const source = mask;
      const valid = runtime === "node" ? source.length !== 0 && findNonOctalDigit(source) === null : matchBunOctal(source) !== null;
      const parsed = parseOctal(source, 8);
      if (!valid || (runtime === "bun" && parsed > 0xffff_ffff)) {
        const received = runtime === "node" ? inspect(source) : `'${source}'`;
        throw assign(new MaskTypeError(`The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received ${received}`), { code: "ERR_INVALID_ARG_VALUE" });
      }
      mask = parsed;
    }
    if (typeof mask !== "number") {
      let received: string;
      // The pinned Node build reports null as undefined in this validator.
      if (mask === null) received = runtime === "node" ? "undefined" : "null";
      else if (typeof mask === "object" || typeof mask === "function") {
        const constructor: unknown = get(mask, "constructor");
        const name: unknown = (typeof constructor === "object" && constructor !== null) || typeof constructor === "function" ? get(constructor, "name") : undefined;
        received = `an instance of ${typeof name === "string" ? name : "Object"}`;
      } else received = `type ${typeof mask} (${inspect(mask)})`;
      throw assign(new MaskTypeError(`The "mask" argument must be of type number. Received ${received}`), { code: "ERR_INVALID_ARG_TYPE" });
    }
    if (!isInteger(mask) || mask < 0 || mask > 0xffff_ffff) {
      const range = isInteger(mask) ? `>= 0 ${runtime === "node" ? "&&" : "and"} <= 4294967295` : "an integer";
      throw assign(new MaskRangeError(`The value of "mask" is out of range. It must be ${range}. Received ${mask}`), { code: "ERR_OUT_OF_RANGE" });
    }
    return call(mask);
  };
}
