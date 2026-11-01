const utf8 = new TextEncoder();
const u32 = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do { const low = rest & 0x7f; rest >>>= 7; bytes.push(rest === 0 ? low : low | 0x80); } while (rest !== 0);
  return bytes;
};
const name = (text: string): number[] => [...u32(text.length), ...utf8.encode(text)];
const vector = (items: readonly (readonly number[])[]): number[] => [...u32(items.length), ...items.flat()];
const section = (id: number, body: readonly number[]): number[] => [id, ...u32(body.length), ...body];

export interface ModuleSpec {
  /** `[module, name]` function imports, each of type () -> (). */
  readonly imports?: readonly (readonly [string, string])[];
  /** Exported function names; each is an empty function of type () -> (). */
  readonly exports?: readonly string[];
  readonly custom?: readonly string[];
  /** Defined memories as `[minPages, maxPages | null, flags]`. */
  readonly memories?: readonly (readonly [number, number | null, number])[];
}

/** Assembles a valid core module with the given imports, exports, memories and empty custom sections. */
export function assemble(spec: ModuleSpec = {}): Uint8Array<ArrayBuffer> {
  const imports = spec.imports ?? [], exports = spec.exports ?? [], memories = spec.memories ?? [];
  const functions = exports.length;
  const body: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  body.push(...section(1, vector([[0x60, 0x00, 0x00]])));
  if (imports.length > 0) body.push(...section(2, vector(imports.map(([module, field]) => [...name(module), ...name(field), 0x00, 0x00]))));
  if (functions > 0) body.push(...section(3, vector(Array.from({ length: functions }, () => [0x00]))));
  if (memories.length > 0) body.push(...section(5, vector(memories.map(([min, max, flags]) => [flags | (max === null ? 0 : 1), ...u32(min), ...(max === null ? [] : u32(max))]))));
  if (functions > 0) body.push(...section(7, vector(exports.map((field, index) => [...name(field), 0x00, ...u32(imports.length + index)]))));
  if (functions > 0) body.push(...section(10, vector(Array.from({ length: functions }, () => [0x02, 0x00, 0x0b]))));
  for (const custom of spec.custom ?? []) body.push(...section(0, name(custom)));
  return Uint8Array.from(body);
}
