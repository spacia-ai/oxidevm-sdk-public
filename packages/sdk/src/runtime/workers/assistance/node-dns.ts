import { Buffer } from "buffer";
import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { pipedChild, type createNativeChildren } from "./node-children.js";
import type { AsyncContext } from "./async-context.js";
import { decodeAssistanceSocketAddress } from "../../protocol/assistance.js";
import { streamError, type Writable } from "./node-streams.js";

type Address = { address: string; family: 4 | 6 };
type Order = "verbatim" | "ipv4first" | "ipv6first";
type Options = { family: 0 | 4 | 6; hints: number; all: boolean; order: Order };
// The managed guest's original Node performs getaddrinfo and owns NSS/hosts,
// resolver configuration and error mapping. This is not an application child
// launcher and does not fetch or resolve anything in the browser worker.
export const nativeLookupSource = `
const input=JSON.parse(process.argv[1]);
require('node:dns').promises.lookup(input.hostname,{...input.options,all:true}).then(
  addresses=>process.stdout.write(JSON.stringify({kind:'addresses',addresses})),
  error=>process.stdout.write(JSON.stringify({kind:'error',message:error.message,code:error.code,errno:error.errno,syscall:error.syscall,hostname:error.hostname}))
);
`;
const MAX_OUTPUT = 65536;

export function createNodeDns(children: Pick<ReturnType<typeof createNativeChildren>, "spawn">, context: AsyncContext, stderr: Writable, dispatch: (callback: () => void) => void = queueMicrotask) {
  let defaultOrder: Order = "verbatim";
  function options(value: unknown = {}): Options {
    const input = typeof value === "number" ? { family: value } : value === null ? {} : record(value, "dns.lookup options");
    const rawFamily = input["family"] ?? 0;
    const family = rawFamily === "IPv4" ? 4 : rawFamily === "IPv6" ? 6 : rawFamily;
    if (family !== 0 && family !== 4 && family !== 6) throw invalid("Invalid DNS address family");
    const rawHints = input["hints"] ?? 0;
    if (typeof rawHints !== "number") throw invalid("Invalid DNS hints");
    const hints = rawHints >>> 0;
    if ((hints & ~56) !== 0) throw invalid("Invalid DNS hints");
    const all = input["all"] ?? false; const verbatim = input["verbatim"];
    if (typeof all !== "boolean" || (verbatim !== undefined && verbatim !== null && typeof verbatim !== "boolean")) throw invalid("Invalid DNS lookup option");
    const order = input["order"] ?? (verbatim === undefined || verbatim === null ? defaultOrder : verbatim ? "verbatim" : "ipv4first");
    return { family, hints, all, order: decodeOrder(order) };
  }
  function hostname(value: unknown): string {
    if (typeof value !== "string" || value.includes("\0")) throw invalid("DNS hostname must be a string without null bytes");
    if (Buffer.byteLength(value) > 4096) throw new VMError("QUOTA_EXCEEDED", "DNS hostname exceeds its bound");
    return value;
  }
  async function perform(name: string, settings: Options): Promise<Address[]> {
    const child = pipedChild(children.spawn("/usr/bin/node", ["-e", nativeLookupSource, JSON.stringify({ hostname: name, options: settings })]));
    const output: Buffer[] = []; let bytes = 0; let failure: Error | undefined;
    return new Promise((resolve, reject) => {
      child.stdout.on("data", value => {
        if (failure !== undefined) return;
        if (!(value instanceof Uint8Array)) { failure = new VMError("PROTOCOL_ERROR", "Invalid guest resolver output"); child.kill("SIGKILL"); return; }
        bytes += value.length;
        if (bytes > MAX_OUTPUT) { failure = new VMError("QUOTA_EXCEEDED", "Guest DNS response exceeds its bound"); child.kill("SIGKILL"); return; }
        output.push(Buffer.from(value));
      });
      child.stderr.pipe(stderr, { end: false });
      child.stdin.on("error", error => { failure = streamError(error); });
      child.on("error", error => { failure = streamError(error); });
      child.on("close", (code, signal) => {
        if (failure !== undefined) { reject(failure); return; }
        if (code !== 0 || signal !== null) { reject(new VMError("GUEST_CRASH", "Guest DNS resolver exited before completion")); return; }
        try { resolve(decodeNativeLookupResult(JSON.parse(Buffer.concat(output).toString()), name)); }
        catch (error) { reject(streamError(error)); }
      });
      child.stdin.end();
    });
  }
  function lookup(name: unknown, optionsOrCallback?: unknown, callback?: unknown): object {
    const host = hostname(name);
    const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (typeof cb !== "function") throw invalid("DNS lookup requires a callback");
    const settings = options(typeof optionsOrCallback === "function" ? undefined : optionsOrCallback);
    const run = context.capture();
    void perform(host, settings).then(addresses => dispatch(() => run(() => {
      if (settings.all) Reflect.apply(cb, undefined, [null, addresses]);
      else Reflect.apply(cb, undefined, [null, addresses[0]?.address ?? null, addresses[0]?.family ?? (settings.family === 6 ? 6 : 4)]);
    })), (error: unknown) => dispatch(() => run(() => { Reflect.apply(cb, undefined, [streamError(error)]); })));
    return {};
  }
  const promises = {
    async lookup(name: unknown, value?: unknown): Promise<{ address: string | null; family: 4 | 6 } | Address[]> {
      const host = hostname(name); const settings = options(value); const addresses = await perform(host, settings);
      if (settings.all) return addresses;
      return addresses[0] ?? { address: null, family: settings.family === 6 ? 6 : 4 };
    },
    getDefaultResultOrder: () => defaultOrder,
    setDefaultResultOrder: (value: unknown): void => { defaultOrder = decodeOrder(value); },
  };
  return { lookup, promises, getDefaultResultOrder: promises.getDefaultResultOrder, setDefaultResultOrder: promises.setDefaultResultOrder,
    ADDRCONFIG: 32, V4MAPPED: 8, ALL: 16 };
}
function decodeOrder(value: unknown): Order {
  if (value !== "verbatim" && value !== "ipv4first" && value !== "ipv6first") throw invalid("Invalid DNS result order");
  return value;
}
function invalid(message: string): TypeError { return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_VALUE" }); }
export class NativeDNSLookupError extends Error {
  readonly syscall = "getaddrinfo";
  constructor(message: string, readonly code: string, readonly errno: number, readonly hostname: string) { super(message); }
}

export function decodeNativeLookupResult(value: unknown, hostname: string): Address[] {
  const result = record(value, "guest DNS result");
  if (result["kind"] === "addresses") {
    exactKeys(result, ["kind", "addresses"]);
    const values = result["addresses"];
    if (!Array.isArray(values) || values.length > 256) throw new VMError("PROTOCOL_ERROR", "Invalid DNS result count");
    return values.map((value: unknown) => {
      const address = record(value, "DNS address"); exactKeys(address, ["address", "family"]);
      const family = address["family"];
      if (family !== 4 && family !== 6) throw new VMError("PROTOCOL_ERROR", "Invalid DNS address family");
      const text = string(address["address"], "DNS address");
      decodeAssistanceSocketAddress({ address: text, port: 1 });
      if ((text.includes(":") ? 6 : 4) !== family) throw new VMError("PROTOCOL_ERROR", "Wrong DNS address family");
      return { address: text, family };
    });
  }
  if (result["kind"] === "error") {
    exactKeys(result, ["kind", "message", "code", "errno", "syscall", "hostname"]);
    if (result["hostname"] !== hostname || result["syscall"] !== "getaddrinfo") throw new VMError("PROTOCOL_ERROR", "Wrong DNS error identity");
    const code = string(result["code"], "DNS error code"); const message = string(result["message"], "DNS error message");
    if (code.length > 64 || message.length > 8192) throw new VMError("PROTOCOL_ERROR", "Invalid DNS error size");
    throw new NativeDNSLookupError(message, code, integer(result["errno"], "DNS errno", -0x8000_0000, -1), hostname);
  }
  throw new VMError("PROTOCOL_ERROR", "Unknown DNS result");
}
