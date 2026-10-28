import { Buffer } from "buffer";
import { exactKeys, integer, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeAssistanceSocketAddress } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { ProcessIO } from "./process-io.js";
import type { createSocketDefaults, SocketRuntime } from "./node-socket-defaults.js";
import { nodeResult } from "./node-file-operations.js";
import { streamError } from "./node-streams.js";

type Address = { address: string; family: 4 | 6 };
type SocketInfo = Extract<AssistanceResult, { kind: "socket" }>;
type Defaults = ReturnType<typeof createSocketDefaults>;
export type SocketLookup = (host: unknown, options: unknown, callback: unknown) => unknown;
export interface SocketNetworking { readonly defaults?: SocketRuntime; readonly lookup?: SocketLookup }
interface Options {
  readonly host: string; readonly port: number; readonly family: 0 | 4 | 6; readonly hints: number;
  readonly auto: boolean; readonly timeout: number; readonly lookup: SocketLookup | undefined;
}
interface Control {
  readonly signal: AbortSignal;
  emit(event: string, ...args: unknown[]): void;
  attempted(addresses: string[]): void;
}
const schedule = globalThis.setTimeout.bind(globalThis), cancel = globalThis.clearTimeout.bind(globalThis);
const connectError = (code: string, message: string) => Object.assign(new Error(message), { code });

export function socketConnectArguments(args: unknown[], defaults: Defaults, lookup?: SocketLookup) {
  const last = args.at(-1), callback = typeof last === "function" ? last : undefined;
  if (callback !== undefined) args.pop();
  let options: Record<string, unknown>;
  if (typeof args[0] === "object" && args[0] !== null) {
    if (args.length !== 1) throw new TypeError("Unsupported net.Socket.connect arguments");
    options = record(args[0], "net.connect options");
    exactKeys(options, ["port"], ["host", "family", "hints", "lookup", "autoSelectFamily", "autoSelectFamilyAttemptTimeout"]);
  } else {
    if (args.length < 1 || args.length > 2) throw new TypeError("Unsupported net.Socket.connect arguments");
    options = { port: args[0], host: args[1] };
  }
  const rawPort = options["port"], port = integer(typeof rawPort === "string" && /^[0-9]+$/u.test(rawPort) ? Number(rawPort) : rawPort, "socket port", 1, 65535);
  const host = options["host"] ?? "localhost";
  if (typeof host !== "string" || host.length === 0 || host.includes("\0") || Buffer.byteLength(host) > 4096) throw new TypeError("Invalid socket hostname");
  const family = options["family"] ?? 0;
  if (family !== 0 && family !== 4 && family !== 6) throw new TypeError("Invalid socket family");
  const hints = integer(options["hints"] ?? 32, "socket DNS hints", 0, 56);
  if ((hints & ~56) !== 0) throw new TypeError("Invalid socket DNS hints");
  const auto = options["autoSelectFamily"] === undefined ? defaults.getDefaultAutoSelectFamily() : options["autoSelectFamily"];
  if (typeof auto !== "boolean") throw new TypeError("Invalid socket autoSelectFamily");
  const timeout = options["autoSelectFamilyAttemptTimeout"] === undefined ? defaults.getDefaultAutoSelectFamilyAttemptTimeout() : defaults.timeout(options["autoSelectFamilyAttemptTimeout"], "autoSelectFamilyAttemptTimeout");
  const custom = options["lookup"];
  if (custom !== undefined && typeof custom !== "function") throw new TypeError("Invalid socket lookup function");
  const resolver: SocketLookup | undefined = typeof custom === "function" ? (host, options, callback) => {
    const value: unknown = Reflect.apply(custom, undefined, [host, options, callback]); return value;
  } : lookup;
  return { options: { host, port, family, hints, auto, timeout, lookup: resolver } satisfies Options, callback };
}

/** Each attempt uses the existing Rust connect/cancel/close authority. */
export function connectSocket(io: Pick<ProcessIO, "call">, options: Options, control: Control): Promise<SocketInfo> {
  const ip = ipFamily(options.host);
  if (ip !== 0) return attempts(io, options, [{ address: options.host, family: ip }], false, control);
  if (options.lookup === undefined) {
    if (options.host === "localhost") return attempts(io, options, [{ address: "127.0.0.1", family: 4 }], false, control);
    throw new VMError("FEATURE_NOT_AVAILABLE", "Socket DNS lookup owner is unavailable");
  }
  const multiple = options.auto && options.family === 0;
  return new Promise((resolve, reject) => {
    let completed = false;
    const aborted = () => { if (!completed) { completed = true; reject(streamError(control.signal.reason)); } };
    control.signal.addEventListener("abort", aborted, { once: true });
    const callback = (error: unknown, value: unknown, family?: unknown) => {
      if (completed) return;
      completed = true; control.signal.removeEventListener("abort", aborted);
      if (error !== null && error !== undefined) { reject(streamError(error)); return; }
      try {
        const values = multiple ? value : [{ address: value, family }];
        const addresses = lookupAddresses(values);
        for (const address of addresses) control.emit("lookup", null, address.address, address.family, options.host);
        const selected = multiple ? alternate(addresses) : addresses;
        resolve(attempts(io, options, selected, multiple && selected.length > 1, control));
      } catch (failure) { reject(streamError(failure)); }
    };
    try {
      if (control.signal.aborted) { aborted(); return; }
      const settings = multiple ? { hints: options.hints, all: true } : { family: options.family, hints: options.hints };
      options.lookup?.(options.host, settings, callback);
    } catch (error) { control.signal.removeEventListener("abort", aborted); reject(streamError(error)); }
  });
}

async function attempts(io: Pick<ProcessIO, "call">, options: Options, addresses: Address[], multiple: boolean, control: Control): Promise<SocketInfo> {
  const errors: Error[] = [], attempted: string[] = [];
  if (multiple && addresses.length > 1) control.attempted(attempted);
  for (const [index, address] of addresses.entries()) {
    control.signal.throwIfAborted();
    control.emit("connectionAttempt", address.address, options.port, address.family);
    attempted.push(`${address.address}:${options.port}`);
    const attempt = new AbortController(), abort = () => { attempt.abort(control.signal.reason); };
    control.signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof schedule> | undefined;
    const deadline = { expired: false };
    try {
      const pending = io.call({ kind: "socket-connect-local", address: { address: address.address, port: options.port } }, false, multiple && addresses.length > 1 ? attempt.signal : undefined);
      if (multiple && index + 1 < addresses.length) timer = schedule(() => { deadline.expired = true; attempt.abort(); }, options.timeout);
      const result = nodeResult(await pending);
      if (result.kind !== "socket" || result.peer === null) throw new VMError("PROTOCOL_ERROR", "Linux did not connect the socket");
      if (deadline.expired || control.signal.aborted) {
        nodeResult(await io.call({ kind: "socket-close", fd: result.fd }, false));
        if (control.signal.aborted) control.signal.throwIfAborted();
        throw connectError("ETIMEDOUT", "Connection attempt timed out");
      }
      return result;
    } catch (error) {
      control.signal.throwIfAborted();
      if (error instanceof VMError) throw error;
      const failure = connectionFailure(error, address.address, options.port, deadline.expired);
      errors.push(failure);
      control.emit(deadline.expired ? "connectionAttemptTimeout" : "connectionAttemptFailed", address.address, options.port, address.family, ...(deadline.expired ? [] : [failure]));
      if (!multiple) throw failure;
    } finally {
      if (timer !== undefined) cancel(timer);
      control.signal.removeEventListener("abort", abort);
    }
  }
  const first = errors[0];
  if (first === undefined) throw connectError("ERR_INVALID_IP_ADDRESS", "DNS lookup returned no addresses");
  const code: unknown = Reflect.get(first, "code");
  throw Object.assign(new AggregateError(errors), { code });
}
function lookupAddresses(input: unknown): Address[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 256) throw connectError("ERR_INVALID_IP_ADDRESS", "Invalid DNS address count");
  return input.map((value: unknown) => {
    const entry = record(value, "socket DNS address");
    const address = entry["address"], family = entry["family"];
    if (typeof address !== "string" || (family !== 4 && family !== 6) || ipFamily(address) !== family) throw connectError("ERR_INVALID_IP_ADDRESS", "Invalid DNS address");
    return { address, family };
  });
}
function alternate(addresses: Address[]): Address[] {
  const first = addresses[0]?.family, seen = new Set<string>(), primary: Address[] = [], secondary: Address[] = [];
  for (const address of addresses) {
    if (seen.has(address.address)) continue;
    seen.add(address.address); (address.family === first ? primary : secondary).push(address);
  }
  return primary.flatMap((address, index) => secondary[index] === undefined ? [address] : [address, secondary[index]]).concat(secondary.slice(primary.length));
}
function ipFamily(input: string): 0 | 4 | 6 {
  try { decodeAssistanceSocketAddress({ address: input, port: 1 }); return input.includes(":") ? 6 : 4; } catch { return 0; }
}
function connectionFailure(error: unknown, address: string, port: number, timedOut: boolean): Error {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  const name = timedOut ? "ETIMEDOUT" : typeof code === "string" ? code : undefined;
  if (name === undefined) throw error;
  const errno: unknown = error instanceof Error ? Reflect.get(error, "errno") : undefined;
  return Object.assign(new Error(`connect ${name} ${address}:${port}`), { code: name, errno: timedOut ? -110 : errno, syscall: "connect", address, port });
}
