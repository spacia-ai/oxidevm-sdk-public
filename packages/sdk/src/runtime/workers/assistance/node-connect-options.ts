import type { VMError } from "../../errors.js";
import { lateFailureError } from "../../js-process/late-failure.js";

/**
 * How the assisted http.request, http.Agent and tls.connect read an application's options: the way Node does.
 * Keys Node never reads are ignored, and so are keys that only tune buffers, timers or caches. A key Node reads
 * that the assisted path cannot honor is refused by name when Node's own test says it is set; unset it is ignored.
 */

/** Node's own test for whether one option is set. */
export type SetTest = (value: unknown) => boolean;
export type SetTests = Readonly<Record<string, SetTest>>;

/** Set unless null or undefined. */
export const present: SetTest = value => value !== null && value !== undefined;
/** Set when truthy, as in Node's `if (options.x)`. */
export const truthy: SetTest = value => Boolean(value);
const callable: SetTest = value => typeof value === "function";

/** net.Socket uses an onread only with a buffer (or a function making one) and a callback. */
const onread: SetTest = value => typeof value === "object" && value !== null && "buffer" in value && "callback" in value
  && (value.buffer instanceof Uint8Array || typeof value.buffer === "function") && typeof value.callback === "function";

/**
 * Connection keys Node reads for every socket that http.request, http.Agent and tls.connect open, which the assisted
 * HTTP agent and TLS helper do not take: net's lookupAndConnect reads localAddress and localPort when truthy, a lookup
 * function, a family of 4 or 6 (or "IPv4" and "IPv6") and non-zero hints; net.Socket reads allowHalfOpen and onread,
 * and TLSSocket passes both on to the net.Socket it builds.
 */
export const UNSUPPORTED_CONNECT_OPTIONS: SetTests = {
  localAddress: Boolean, localPort: Boolean, lookup: callable,
  family: value => value === 4 || value === 6 || value === "IPv4" || value === "IPv6",
  hints: value => typeof value === "number" && value !== 0,
  allowHalfOpen: Boolean, onread,
};

/**
 * Keys only net.Socket's constructor reads: an fd to open when it is not undefined, and a truthy blockList. Plain
 * http.request and http.Agent hand their options to it; TLSSocket builds its net.Socket from a fixed set of keys
 * that holds neither, so https and tls.connect never read them.
 */
export const UNSUPPORTED_NET_SOCKET_OPTIONS: SetTests = { fd: value => value !== undefined, blockList: Boolean };

/** `defaultPort` as Node reads it: set when truthy, and unsupported when it names another port than the protocol's. */
export function otherDefaultPort(defaultPort: number): SetTest {
  return value => Boolean(value) && Number(value) !== defaultPort;
}

/** The application's options copied the way Node copies them: own enumerable properties onto a null-prototype object. */
export function copyOptions(value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = {}; Object.setPrototypeOf(copy, null);
  return Object.assign(copy, value);
}

/**
 * Refuses, before any connection, the first key whose test holds. The app can catch the late failure; uncaught,
 * ADR 0026 runs the program in real Linux next time. `call` names the API in the message, `builtin` the module.
 */
export function refuseSetOptions(options: Readonly<Record<string, unknown>>, tests: SetTests, call: string, builtin: string): void {
  const key = Object.keys(tests).find(name => tests[name]?.(options[name]) === true);
  if (key !== undefined) throw unsupportedOption(key, call, builtin);
}

/** The late failure for option `key`, or for the form of its value that `what` names. */
export function unsupportedOption(key: string, call: string, builtin: string, what: string = key): VMError {
  return lateFailureError("unavailable-builtin", `${what} is not supported for ${call}`, `node:${builtin} ${key}`);
}
