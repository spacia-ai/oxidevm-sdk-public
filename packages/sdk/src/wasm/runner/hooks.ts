import { VMError } from "../../runtime/errors.js";
import type { Connection, CommandIO } from "../define.js";

/** Stable `detail.reason` for an adapter that does not have the shape its manifest requires. */
export const ADAPTER_REASON = "wasm-module-adapter";

/** Which rule an adapter fault (exit status 123) broke; tools read this instead of the message. */
export type AdapterFault = "shape" | "exit-status" | "thrown" | "undeclared-capability";

/** The adapter's factory result did not match the module kind; the runner reports exit status 123. */
export class AdapterShapeError extends VMError {
  readonly fault: Extract<AdapterFault, "shape" | "exit-status">;
  constructor(message: string, fault: Extract<AdapterFault, "shape" | "exit-status"> = "shape") {
    super("GUEST_CRASH", message, { reason: ADAPTER_REASON });
    this.name = "AdapterShapeError";
    this.fault = fault;
  }
}

/** A command adapter, normalized so every hook is asynchronous and a synchronous throw becomes a rejection. */
export interface CommandRun {
  main(io: CommandIO): Promise<unknown>;
  close(): Promise<void>;
}

export interface ServiceRun {
  info(): Promise<unknown>;
  readonly handlers: ReadonlyMap<string, (connection: Connection) => Promise<void>>;
  close(): Promise<void>;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Rejects members the contract does not define, which catches a misspelled optional hook such as
 * `clsoe`. TypeScript cannot, because it does not check extra properties on a returned object. A class
 * instance legitimately carries its own fields, so only plain object literals are held to the list.
 */
function onlyKeys(value: object, allowed: readonly string[], label: string): void {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AdapterShapeError(`${label} has an unknown member ${key}`);
}

/** A function member of an adapter object, callable with the owner as `this`; its result stays `unknown`. */
function member(value: object, key: string, label: string, required: boolean): ((...args: unknown[]) => unknown) | undefined {
  const found: unknown = Reflect.get(value, key);
  if (found === undefined && !required) return undefined;
  if (typeof found !== "function") throw new AdapterShapeError(`${label}.${key} must be a function`);
  return (...args) => {
    const result: unknown = Reflect.apply(found, value, args);
    return result;
  };
}

function closer(value: object, label: string): () => Promise<void> {
  const close = member(value, "close", label, false);
  return async () => { await close?.(); };
}

/** Validates what a command adapter's factory returned: `main` (required) and `close`, nothing else. */
export function commandRun(value: unknown): CommandRun {
  if (!isObject(value)) throw new AdapterShapeError("The adapter must return an object with a main function");
  onlyKeys(value, ["main", "close"], "adapter");
  const main = member(value, "main", "adapter", true);
  if (main === undefined) throw new AdapterShapeError("adapter.main must be a function");
  return { main: async io => await main(io), close: closer(value, "adapter") };
}

/** Validates a service adapter: one handler per declared endpoint, optional `info` and `close`, nothing else. */
export function serviceRun(value: unknown, endpoints: readonly string[]): ServiceRun {
  if (!isObject(value)) throw new AdapterShapeError("The adapter must return an object with a protocols record");
  onlyKeys(value, ["info", "protocols", "close"], "adapter");
  const protocols: unknown = Reflect.get(value, "protocols");
  if (!isObject(protocols) || Array.isArray(protocols)) throw new AdapterShapeError("adapter.protocols must be an object");
  const provided = Object.keys(protocols);
  for (const name of endpoints) if (!provided.includes(name)) throw new AdapterShapeError(`adapter.protocols has no handler for ${name}`);
  for (const name of provided) if (!endpoints.includes(name)) throw new AdapterShapeError(`adapter.protocols.${name} is not a declared endpoint`);
  const handlers = new Map<string, (connection: Connection) => Promise<void>>();
  for (const name of endpoints) {
    const handler = member(protocols, name, "adapter.protocols", true);
    if (handler === undefined) throw new AdapterShapeError(`adapter.protocols.${name} must be a function`);
    handlers.set(name, async connection => { await handler(connection); });
  }
  const info = member(value, "info", "adapter", false);
  return { info: async () => await info?.(), handlers, close: closer(value, "adapter") };
}
