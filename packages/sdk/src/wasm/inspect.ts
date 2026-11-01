import { VMError } from "../runtime/errors.js";
import type { AbiKind } from "./manifest-types.js";
import type { WasmReport } from "./inspect-types.js";

export type { WasmReport } from "./inspect-types.js";

const MAX_BYTES = 512 * 1024 ** 2;
const MAX_LISTED_EXPORTS = 200;

function leb(bytes: Uint8Array, offset: number): readonly [number, number] {
  let result = 0, shift = 0, at = offset;
  for (let count = 0; count < 5; count++) {
    const byte = bytes[at++];
    if (byte === undefined) break;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, at];
    shift += 7;
  }
  throw new VMError("INVALID_ARGUMENT", "the WebAssembly binary has a malformed length");
}

/** Walks the top-level sections: the names of custom sections and the limits of defined memories. */
function sections(bytes: Uint8Array): { readonly custom: readonly string[]; readonly memories: WasmReport["memories"] } {
  const custom: string[] = [], memories: WasmReport["memories"][number][] = [];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at++];
    const [size, bodyAt] = leb(bytes, at);
    const end = bodyAt + size;
    if (id === undefined || end > bytes.length) throw new VMError("INVALID_ARGUMENT", "the WebAssembly binary has a section that runs past its end");
    if (id === 0) {
      const [length, nameAt] = leb(bytes, bodyAt);
      custom.push(new TextDecoder().decode(bytes.subarray(nameAt, Math.min(nameAt + length, end))));
    } else if (id === 5) {
      const [count, first] = leb(bytes, bodyAt);
      let p = first;
      for (let index = 0; index < count && p < end; index++) {
        const flags = bytes[p++] ?? 0;
        const [min, afterMin] = leb(bytes, p);
        p = afterMin;
        let max: number | null = null;
        if ((flags & 1) !== 0) { const [value, afterMax] = leb(bytes, p); p = afterMax; max = value; }
        memories.push({ minPages: min, maxPages: max, shared: (flags & 2) !== 0, memory64: (flags & 4) !== 0 });
      }
    }
    at = end;
  }
  return { custom, memories };
}

function classify(imports: WasmReport["imports"], exports: readonly string[], custom: readonly string[]): { readonly abi: AbiKind; readonly evidence: readonly string[] } {
  const modules = new Set(imports.map(entry => entry.module));
  const evidence: string[] = [];
  const emscripten = custom.includes("dylink.0") || modules.has("GOT.func") || modules.has("GOT.mem") || exports.some(name => /^(?:_emscripten_|emscripten_|__indirect_function_table$|stackSave$|stackRestore$)/u.test(name));
  if (emscripten) {
    if (custom.includes("dylink.0")) evidence.push("has a dylink.0 section");
    if (modules.has("GOT.func") || modules.has("GOT.mem")) evidence.push("imports GOT.func or GOT.mem");
    if (exports.some(name => /^(?:_emscripten_|emscripten_)/u.test(name))) evidence.push("exports emscripten runtime functions");
    if (exports.includes("__indirect_function_table")) evidence.push("exports __indirect_function_table");
    return { abi: "emscripten", evidence };
  }
  if ([...modules].some(name => name === "wbg" || name === "__wbindgen_placeholder__" || name.startsWith("__wbindgen")) || exports.some(name => name.startsWith("__wbindgen_") || name.startsWith("__wbg_"))) return { abi: "bindgen", evidence: ["uses the wasm-bindgen glue namespace"] };
  if ([...modules].some(name => name === "wasi_snapshot_preview1" || name === "wasi_unstable" || name.startsWith("wasi:"))) return { abi: "wasi", evidence: [`imports ${[...modules].filter(name => name.startsWith("wasi")).join(", ")}`] };
  return { abi: "raw", evidence: ["imports nothing the other conventions define"] };
}

/**
 * The parts of the JavaScript WebAssembly API this inspector uses. They are described here, not taken from the DOM
 * library, so the file compiles both for browsers and for Node tools, which share the global but not its typings.
 */
interface WebAssemblyApi {
  compile(bytes: Uint8Array<ArrayBuffer>): Promise<object>;
  readonly Module: {
    imports(module: object): readonly { readonly module: string; readonly name: string }[];
    exports(module: object): readonly { readonly name: string }[];
    customSections(module: object, name: string): readonly unknown[];
  };
}

function hasMethod(owner: unknown, name: string): boolean {
  return (typeof owner === "object" || typeof owner === "function") && owner !== null && typeof Reflect.get(owner, name) === "function";
}

function isWebAssemblyApi(value: unknown): value is WebAssemblyApi {
  const module: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "Module") : undefined;
  return hasMethod(value, "compile") && hasMethod(module, "imports") && hasMethod(module, "exports") && hasMethod(module, "customSections");
}

function webAssembly(): WebAssemblyApi {
  const api: unknown = Reflect.get(globalThis, "WebAssembly");
  if (!isWebAssemblyApi(api)) throw new VMError("FEATURE_NOT_AVAILABLE", "this environment has no WebAssembly");
  return api;
}

/** Reads a binary's shape and guesses its ABI from the imports, exports and sections that each convention leaves behind. */
export async function inspectWasm(bytes: Uint8Array<ArrayBuffer>): Promise<WasmReport> {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_BYTES || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new VMError("INVALID_ARGUMENT", "not a WebAssembly binary");
  const component = bytes[4] === 0x0d && bytes[5] === 0 && bytes[6] === 1 && bytes[7] === 0;
  if (component) return { kind: "component", bytes: bytes.byteLength, imports: [], exports: [], customSections: [], memories: [], abi: "component", evidence: ["is a component (layer 1)"], targetFeatures: false };
  if (!(bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0)) throw new VMError("INVALID_ARGUMENT", "unsupported WebAssembly version");
  const api = webAssembly();
  let compiled: object;
  try { compiled = await api.compile(bytes); } catch { throw new VMError("INVALID_ARGUMENT", "the WebAssembly binary does not validate"); }
  const grouped = new Map<string, number>();
  for (const entry of api.Module.imports(compiled)) grouped.set(entry.module, (grouped.get(entry.module) ?? 0) + 1);
  const imports = [...grouped].map(([module, names]) => ({ module, names })).sort((left, right) => left.module < right.module ? -1 : 1);
  const exports = api.Module.exports(compiled).map(entry => entry.name);
  const { custom, memories } = sections(bytes);
  const { abi, evidence } = classify(imports, exports, custom);
  return { kind: "module", bytes: bytes.byteLength, imports, exports: exports.slice(0, MAX_LISTED_EXPORTS), customSections: [...new Set(custom)].sort(), memories, abi, evidence, targetFeatures: api.Module.customSections(compiled, "target_features").length > 0 };
}
