import { VMError } from "../../errors.js";
import { MAX_JIT_MODULE_BYTES, MAX_LINKED_JIT_MEMBERS } from "../../jit-cache.js";
import { callNumber, memorySlice, readExportedBytes, type Core } from "./core.js";

/** Links standalone Tier-1 modules into one module through the core's stateless linker
 * (`jit/emit/link.rs`), so the engine compiles a batch of translations at once. Member `i` of a
 * linked module is entry `i` of its `member_table` and `record_member_table`. */

/** Member bytes of one linked module. A linked module is smaller than its members together, so
 * it stays within the compiler's module bound. */
export const MAX_LINKED_BYTES = MAX_JIT_MODULE_BYTES;

const WASM_HEADER = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0] as const;
/** Sections a member may carry: custom, type, import, function, table, export, element, code. */
const MEMBER_SECTIONS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 7, 9, 10]);
/** The core linker admits one type-0 trace and at most two private helpers. */
const MAX_MEMBER_FUNCTIONS = 3;
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/**
 * The link signature of a standalone Tier-1 module: its type and import sections, which every
 * member of one linked module shares, plus the exact types and bodies of its private helpers.
 * Helpers keep their original indices in the linked module. A profile build's second type-0
 * trace remains ineligible, as required by the core linker (`jit/emit/link.rs`).
 */
export function jitLinkSignature(module: Uint8Array): string | null {
  if (module.byteLength < WASM_HEADER.length) return null;
  for (const [index, byte] of WASM_HEADER.entries()) if (module[index] !== byte) return null;
  let types: Uint8Array | undefined;
  let imports: Uint8Array | undefined;
  let functions: Uint8Array | undefined;
  let code: Uint8Array | undefined;
  let offset: number = WASM_HEADER.length;
  while (offset < module.byteLength) {
    const id = module[offset] ?? -1;
    const size = readUnsigned(module, offset + 1);
    if (size === undefined || !MEMBER_SECTIONS.has(id)) return null;
    const end = size.next + size.value;
    if (end > module.byteLength) return null;
    const payload = module.subarray(size.next, end);
    if (id === 1) { if (types !== undefined) return null; types = payload; }
    else if (id === 2) { if (imports !== undefined) return null; imports = payload; }
    else if (id === 3) { if (functions !== undefined) return null; functions = payload; }
    else if (id === 10) { if (code !== undefined) return null; code = payload; }
    offset = end;
  }
  if (
    types === undefined ||
    imports === undefined ||
    functions === undefined || code === undefined
  ) {
    return null;
  }
  const helpers = helperSignature(functions, code);
  return helpers === null ? null : `${hex(types)}:${hex(imports)}:${helpers}`;
}

function helperSignature(functions: Uint8Array, code: Uint8Array): string | null {
  const count = readUnsigned(functions, 0);
  const bodies = readUnsigned(code, 0);
  if (count === undefined || count.value < 1 || count.value > MAX_MEMBER_FUNCTIONS
    || bodies?.value !== count.value) return null;
  let typeOffset = count.next;
  let bodyOffset = bodies.next;
  const helpers: string[] = [];
  for (let index = 0; index < count.value; index++) {
    const type = readUnsigned(functions, typeOffset);
    const body = readUnsigned(code, bodyOffset);
    if (type === undefined || body === undefined || (index === 0 ? type.value !== 0 : type.value === 0)) return null;
    const end = body.next + body.value;
    if (end > code.byteLength) return null;
    if (index > 0) helpers.push(`${String(type.value)}:${hex(code.subarray(body.next, end))}`);
    typeOffset = type.next;
    bodyOffset = end;
  }
  return typeOffset === functions.byteLength && bodyOffset === code.byteLength ? helpers.join(":") : null;
}

/**
 * Links `modules`, which share one link signature, into one module. Returns `undefined` when the
 * core refuses them; the caller compiles them standalone instead.
 */
export function linkJitModules(
  loaded: Core,
  modules: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> | undefined {
  if (modules.length === 0 || modules.length > MAX_LINKED_JIT_MEMBERS) {
    throw new VMError("VM_FAULT", "JIT link members are invalid");
  }
  const length = modules.reduce((total, module) => total + 4 + module.byteLength, 0);
  if (callNumber(loaded, "oxidevm_staging_resize", [length]) !== 0) return undefined;
  const pointer = callNumber(loaded, "oxidevm_staging_ptr");
  const staging = memorySlice(loaded.memory, pointer, length);
  const view = new DataView(staging.buffer, staging.byteOffset, length);
  let offset = 0;
  for (const module of modules) {
    view.setUint32(offset, module.byteLength, true);
    staging.set(module, offset + 4);
    offset += 4 + module.byteLength;
  }
  if (callNumber(loaded, "oxidevm_jit_link_modules", [modules.length, length]) !== 0) {
    return undefined;
  }
  return readExportedBytes(loaded, "oxidevm_jit_linked_module");
}

function readUnsigned(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } | undefined {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = bytes[offset];
    if (byte === undefined) return undefined;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
  }
  return undefined;
}

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += HEX[byte] ?? "";
  return text;
}
