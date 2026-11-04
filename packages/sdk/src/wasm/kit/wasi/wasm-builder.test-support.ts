// Hand-encoded WebAssembly modules for admission and memory tests: each is the smallest binary with one property the
// profile must accept or refuse (an import, a memory shape, an export), so a test names exactly what it checks.
const text = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [bytes.length, ...bytes]; };
const section = (id: number, body: readonly number[]): number[] => [id, ...leb(body.length), ...body];
function leb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do { let byte = rest & 0x7f; rest = Math.floor(rest / 128); if (rest !== 0) byte |= 0x80; out.push(byte); } while (rest !== 0);
  return out;
}

export interface ModuleSpec {
  readonly functionImports?: readonly (readonly [string, string])[];
  /** Imports a memory instead of defining one. */
  readonly importMemory?: boolean;
  /** The defined memory's pages; `max: null` declares no maximum. */
  readonly memory?: { readonly min: number; readonly max: number | null };
  readonly start?: boolean;
  readonly exportStart?: boolean;
  readonly exportMemory?: boolean;
}

/** Builds a module whose `_start` does nothing; type 0 is `() -> ()`. */
export function wasm(spec: ModuleSpec = {}): Uint8Array<ArrayBuffer> {
  const imports = spec.functionImports ?? [];
  const importEntries = imports.flatMap(([module, name]) => [...text(module), ...text(name), 0x00, 0x00]);
  const memoryImport = spec.importMemory === true ? [...text("env"), ...text("memory"), 0x02, 0x00, 0x01] : [];
  const importCount = imports.length + (spec.importMemory === true ? 1 : 0);
  const memory = spec.memory ?? { min: 1, max: 1 };
  const limits = memory.max === null ? [0x00, ...leb(memory.min)] : [0x01, ...leb(memory.min), ...leb(memory.max)];
  const startIndex = imports.length;
  const exports: number[][] = [];
  if (spec.exportStart !== false) exports.push([...text("_start"), 0x00, ...leb(startIndex)]);
  if (spec.exportMemory !== false) exports.push([...text("memory"), 0x02, 0x00]);
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...(importCount === 0 ? [] : section(2, [...leb(importCount), ...importEntries, ...memoryImport])),
    ...section(3, [0x01, 0x00]),
    ...(spec.importMemory === true ? [] : section(5, [0x01, ...limits])),
    ...section(7, [...leb(exports.length), ...exports.flat()]),
    ...(spec.start === true ? section(8, leb(startIndex)) : []),
    ...section(10, [0x01, 0x02, 0x00, 0x0b]),
  ]);
}
