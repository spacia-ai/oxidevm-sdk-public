import { VMError } from "../../errors.js";
import { nodeUtil } from "./node-util.js";

export interface SocketRuntime {
  readonly runtime: "node" | "bun";
  readonly autoSelectFamily?: Int32Array;
}
const isInteger = Number.isInteger, inspect = nodeUtil.inspect, get = Reflect.get, assign = Object.assign;
const load = Atomics.load, store = Atomics.store, DefaultTypeError = TypeError, DefaultRangeError = RangeError;

/** Node owns per-environment defaults. Bun shares only its family flag between workers. */
export function createSocketDefaults(settings: SocketRuntime = { runtime: "node" }) {
  const shared = settings.autoSelectFamily, runtime = settings.runtime;
  if (shared !== undefined && (runtime !== "bun" || !(shared.buffer instanceof SharedArrayBuffer) || shared.length !== 1)) throw new VMError("PROTOCOL_ERROR", "Invalid shared socket defaults");
  let autoSelectFamily = true, attemptTimeout = 250;
  const getDefaultAutoSelectFamily = () => shared === undefined ? autoSelectFamily : load(shared, 0) === 1;
  const timeout = (value: unknown, name = "value"): number => {
    if (typeof value !== "number") throw invalidType(value, "number", name, runtime);
    if (!isInteger(value) || value < 1 || value > 0x7fff_ffff) {
      const range = isInteger(value) ? `>= 1 ${runtime === "node" ? "&&" : "and"} <= 2147483647` : "an integer";
      throw assign(new DefaultRangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${value}`), { code: "ERR_OUT_OF_RANGE" });
    }
    return value < 10 ? 10 : value;
  };
  return {
    getDefaultAutoSelectFamily,
    setDefaultAutoSelectFamily: (value: unknown): boolean | undefined => {
      if (typeof value !== "boolean") throw invalidType(value, "boolean", "value", runtime);
      if (shared === undefined) autoSelectFamily = value; else store(shared, 0, value ? 1 : 0);
      return runtime === "bun" ? value : undefined;
    },
    getDefaultAutoSelectFamilyAttemptTimeout: () => attemptTimeout,
    setDefaultAutoSelectFamilyAttemptTimeout: (value: unknown): number | undefined => {
      attemptTimeout = timeout(value);
      return runtime === "bun" ? attemptTimeout : undefined;
    },
    timeout,
  };
}
function invalidType(value: unknown, expected: "number" | "boolean", name: string, runtime: "node" | "bun"): TypeError {
  let message: string;
  if (runtime === "bun") message = expected === "boolean" ? "autoSelectFamilyDefault" : `The "${name}" property must be of type number, got ${typeof value}`;
  else {
    let received: string;
    if (value === undefined || value === null) received = String(value);
    else if (typeof value === "object" || typeof value === "function") {
      const constructor: unknown = get(value, "constructor"), kind: unknown = typeof constructor === "function" ? get(constructor, "name") : undefined;
      received = `an instance of ${typeof kind === "string" ? kind : "Object"}`;
    } else received = `type ${typeof value} (${inspect(value)})`;
    message = `The "${name}" argument must be of type ${expected}. Received ${received}`;
  }
  return assign(new DefaultTypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
}
