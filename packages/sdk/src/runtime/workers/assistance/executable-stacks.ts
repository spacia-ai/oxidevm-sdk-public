import { fileURLToPath } from "./node-url.ts";
import { record } from "../../decode.ts";
import type { ExecutableSources } from "./executable-sources.ts";

/** Default V8 formatting hides runtime lowering, while an application's own
 * prepareStackTrace remains writable and receives native CallSite objects. */
export function installExecutableStacks(sources: ExecutableSources, realmValue: unknown): () => void {
  const realm = record(realmValue, "stack realm");
  const constructor = realm["Error"];
  if (typeof constructor !== "function") throw new TypeError("Realm has no Error constructor");
  const prototype: unknown = Reflect.get(constructor, "prototype");
  const toString = method(prototype, "toString");
  const previous = Object.getOwnPropertyDescriptor(constructor, "prepareStackTrace");
  const formatter = (error: unknown, frames: unknown): string => {
    if (!Array.isArray(frames)) throw new TypeError("Invalid V8 stack frames");
    const header: unknown = Reflect.apply(toString, error, []);
    if (typeof header !== "string") throw new TypeError("Invalid Error string");
    const values: readonly unknown[] = frames;
    return header + values.map(frame => `\n    at ${formatFrame(sources, frame)}`).join("");
  };
  Object.defineProperty(constructor, "prepareStackTrace", { configurable: true, writable: true, value: formatter });
  return () => {
    if (previous === undefined) Reflect.deleteProperty(constructor, "prepareStackTrace");
    else Object.defineProperty(constructor, "prepareStackTrace", previous);
  };
}

function formatFrame(sources: ExecutableSources, frame: unknown): string {
  const text: unknown = Reflect.apply(method(frame, "toString"), frame, []);
  if (typeof text !== "string") throw new TypeError("Invalid V8 frame string");
  const url: unknown = Reflect.apply(method(frame, "getScriptNameOrSourceURL"), frame, []);
  const line: unknown = Reflect.apply(method(frame, "getLineNumber"), frame, []);
  const column: unknown = Reflect.apply(method(frame, "getColumnNumber"), frame, []);
  if (typeof url !== "string" || typeof line !== "number" || typeof column !== "number") return text;
  const mapping = sources.find(url, line, column);
  const origin = mapping?.origin;
  if (origin === undefined || typeof origin.originalSource !== "string"
    || origin.originalLine === undefined || origin.originalColumn === undefined) return text;
  let filename = origin.originalSource;
  if (filename.startsWith("file:")) {
    try { filename = fileURLToPath(filename); }
    catch { /* A nonlocal/invalid file URL remains a display URL, never a read. */ }
  }
  return text.replace(`${url}:${line}:${column}`, `${filename}:${origin.originalLine + 1}:${origin.originalColumn + 1}`);
}

function method(value: unknown, name: string): (...args: unknown[]) => unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new TypeError("Invalid V8 stack object");
  const fn: unknown = Reflect.get(value, name);
  if (typeof fn !== "function") throw new TypeError(`Missing V8 stack method ${name}`);
  return function (this: unknown, ...args: unknown[]): unknown { return Reflect.apply(fn, this, args); };
}
