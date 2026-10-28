import { Buffer } from "buffer";
import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";

const MAX_BYTES = 64 * 1024 ** 2, MAX_NODES = 65536;
const views = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
const errors = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const unsupported = new Error("Platform clone required");
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid synchronous worker message"); }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new VMError("PROTOCOL_ERROR", `${label} must be an array`); return value; }

/** Only portable clone values have a synchronous representation. Platform capabilities retain their original asynchronous transport. */
export function encodeSynchronousMessage(input: unknown): Uint8Array | null {
  const nodes: unknown[][] = [], seen = new WeakMap<object, number>();
  function visit(value: unknown, depth: number): number {
    if (depth > 128 || nodes.length === MAX_NODES) throw unsupported;
    if (typeof value === "object" && value !== null) { const previous = seen.get(value); if (previous !== undefined) return previous; }
    const id = nodes.length, node: unknown[] = []; nodes.push(node);
    if (typeof value === "object" && value !== null) seen.set(value, id);
    const next = (value: unknown) => visit(value, depth + 1);
    if (value === null || typeof value === "boolean" || typeof value === "string") node.push("value", value);
    else if (value === undefined) node.push("undefined");
    else if (typeof value === "number") node.push("number", Object.is(value, -0) ? "-0" : String(value));
    else if (typeof value === "bigint") node.push("bigint", String(value));
    else if (typeof value !== "object" || value instanceof SharedArrayBuffer || value instanceof MessagePort || value instanceof WebAssembly.Module) throw unsupported;
    else if (value instanceof ArrayBuffer) node.push("buffer", Buffer.from(value).toString("base64"));
    else if (value instanceof DataView) node.push("view", "DataView", next(value.buffer), value.byteOffset, value.byteLength);
    else if (ArrayBuffer.isView(value)) {
      const name = Object.keys(views).find(name => Object.hasOwn(views, name) && value.constructor === Reflect.get(views, name));
      if (name === undefined) throw unsupported;
      node.push("view", name, next(value.buffer), value.byteOffset, value.byteLength);
    } else if (value instanceof Date) node.push("date", String(value.getTime()));
    else if (value instanceof RegExp) node.push("regexp", value.source, value.flags);
    else if (value instanceof Map) node.push("map", [...value].map(([key, entry]) => [next(key), next(entry)]));
    else if (value instanceof Set) node.push("set", [...value].map(next));
    else if (value instanceof Error) node.push("error", value.name, value.message, value.stack ?? null, Object.hasOwn(value, "cause") ? next(value.cause) : null);
    else node.push(Array.isArray(value) ? "array" : "object", Object.keys(value).map(key => [key, next(Reflect.get(value, key))]));
    return id;
  }
  try {
    const root = visit(input, 0), bytes = new TextEncoder().encode(JSON.stringify({ version: 1, root, nodes }));
    return bytes.length <= MAX_BYTES ? bytes : null;
  } catch (error) { if (error === unsupported) return null; throw error; }
}

/** Validate the bounded graph before rebuilding aliases, cycles and binary views. */
export function decodeSynchronousMessage(bytes: Uint8Array): unknown {
  try { return decodeGraph(bytes); }
  catch (error) { if (error instanceof VMError) throw error; throw new VMError("PROTOCOL_ERROR", "Invalid synchronous worker message"); }
}
function decodeGraph(bytes: Uint8Array): unknown {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) invalid();
  const input = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, "worker message graph");
  exactKeys(input, ["version", "root", "nodes"]);
  const values = array(input["nodes"], "worker message nodes");
  if (input["version"] !== 1 || values.length === 0 || values.length > MAX_NODES) invalid();
  const nodes = values.map(value => array(value, "worker message node")), restored: unknown[] = new Array<unknown>(nodes.length);
  const ref = (value: unknown): number => integer(value, "worker value reference", 0, nodes.length - 1);
  const number = (value: unknown): number => {
    const text = string(value, "worker number"), result = Number(text);
    if (text !== (Object.is(result, -0) ? "-0" : String(result))) invalid();
    return result;
  };
  const tagged = (node: unknown[], count: number): void => { if (node.length !== count) invalid(); };
  for (const [index, node] of nodes.entries()) {
    switch (node[0]) {
      case "value": tagged(node, 2); if (node[1] !== null && typeof node[1] !== "boolean" && typeof node[1] !== "string") invalid(); restored[index] = node[1]; break;
      case "undefined": tagged(node, 1); break;
      case "number": tagged(node, 2); restored[index] = number(node[1]); break;
      case "bigint": { tagged(node, 2); const text = string(node[1], "worker bigint"); if (!/^-?(?:0|[1-9]\d*)$/u.test(text)) invalid(); restored[index] = BigInt(text); break; }
      case "buffer": {
        tagged(node, 2); const text = string(node[1], "worker buffer"), data = Buffer.from(text, "base64");
        if (data.toString("base64") !== text) invalid();
        restored[index] = new Uint8Array(data).buffer; break;
      }
      case "date": tagged(node, 2); restored[index] = new Date(number(node[1])); break;
      case "regexp": tagged(node, 3); restored[index] = new RegExp(string(node[1], "worker regexp"), string(node[2], "worker flags")); break;
      case "map": tagged(node, 2); restored[index] = new Map<unknown, unknown>(); break;
      case "set": tagged(node, 2); restored[index] = new Set<unknown>(); break;
      case "array": tagged(node, 2); restored[index] = []; break;
      case "object": tagged(node, 2); restored[index] = {}; break;
      case "error": {
        tagged(node, 5); const name = string(node[1], "worker error name");
        if (!Object.hasOwn(errors, name)) invalid();
        const constructor: unknown = Reflect.get(errors, name); if (typeof constructor !== "function") invalid();
        const error: unknown = Reflect.construct(constructor, [string(node[2], "worker error message")]); restored[index] = error; break;
      }
      case "view": tagged(node, 5); break;
      default: invalid();
    }
  }
  for (const [index, node] of nodes.entries()) if (node[0] === "view") {
    const buffer = restored[ref(node[2])]; if (!(buffer instanceof ArrayBuffer)) invalid();
    const offset = integer(node[3], "worker view offset", 0, buffer.byteLength), length = integer(node[4], "worker view length", 0, buffer.byteLength - offset);
    if (node[1] === "DataView") restored[index] = new DataView(buffer, offset, length);
    else {
      const name = string(node[1], "worker view type");
      if (!Object.hasOwn(views, name)) invalid();
      const constructor: unknown = Reflect.get(views, name);
      if (typeof constructor !== "function") invalid();
      const size: unknown = Reflect.get(constructor, "BYTES_PER_ELEMENT");
      if (typeof size !== "number" || offset % size !== 0 || length % size !== 0) invalid();
      const view: unknown = Reflect.construct(constructor, [buffer, offset, length / size]); restored[index] = view;
    }
  }
  for (const [index, node] of nodes.entries()) {
    const target = restored[index];
    if (node[0] === "array" || node[0] === "object") {
      if (typeof target !== "object" || target === null) invalid();
      for (const value of array(node[1], "worker properties")) {
        const property = array(value, "worker property"); if (property.length !== 2) invalid();
        const key = string(property[0], "worker property key");
        if (Object.hasOwn(target, key)) invalid();
        Object.defineProperty(target, key, { value: restored[ref(property[1])], enumerable: true, configurable: true, writable: true });
      }
    } else if (node[0] === "map") {
      if (!(target instanceof Map)) invalid();
      for (const value of array(node[1], "worker map")) { const pair = array(value, "worker map entry"); if (pair.length !== 2) invalid(); target.set(restored[ref(pair[0])], restored[ref(pair[1])]); }
    } else if (node[0] === "set") {
      if (!(target instanceof Set)) invalid();
      for (const value of array(node[1], "worker set")) target.add(restored[ref(value)]);
    } else if (node[0] === "error") {
      if (!(target instanceof Error)) invalid();
      const name = string(node[1], "worker error name"), stack = node[3];
      if (!["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"].includes(name)) invalid();
      Object.defineProperty(target, "name", { value: name, configurable: true, writable: true });
      if (stack !== null) Object.defineProperty(target, "stack", { value: string(stack, "worker error stack"), configurable: true, writable: true });
      if (node[4] !== null) Object.defineProperty(target, "cause", { value: restored[ref(node[4])], configurable: true, writable: true });
    }
  }
  return restored[ref(input["root"])];
}
