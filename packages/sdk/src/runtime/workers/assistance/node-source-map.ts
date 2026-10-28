import { TraceMap, decodedMappings } from "@jridgewell/trace-mapping";
import { VMError } from "../../errors.ts";
import { record } from "../../decode.ts";

interface Entry {
  generatedLine: number;
  generatedColumn: number;
  originalSource: string | null | undefined;
  originalLine: number | undefined;
  originalColumn: number | undefined;
  name: string | undefined;
}

const MAX_ENTRIES = 1_048_576;
// Qualified bundled CLIs can contain two million mappings within the 16 MiB encoded bound.
const MAX_MAPPINGS = 4_194_304;
const MAX_MAP_BYTES = 16 * 1024 * 1024;

/** Node's public range lookup over the pinned source-map decoder. It performs
 * no filesystem or network reads; module-map admission belongs to the loader. */
export class SourceMap {
  readonly #payload: Record<string, unknown>;
  readonly #entries: Entry[] = [];
  readonly #lineLengths: number[] | undefined;
  #mapCount = 0;

  constructor(payload: unknown, options?: unknown) {
    this.#payload = copyPayload(payload);
    this.#append(this.#payload, 0, 0, 0);
    this.#entries.sort((a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn);
    const lengths = options === undefined ? undefined : object(options)["lineLengths"];
    if (lengths !== undefined) {
      if (!Array.isArray(lengths) || !lengths.every((value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw invalid("line lengths");
      this.#lineLengths = lengths.length === 0 ? undefined : lengths;
    }
  }

  get payload(): Record<string, unknown> { return copyPayload(this.#payload); }
  get lineLengths(): number[] | undefined { return this.#lineLengths?.slice(); }

  findEntry(lineOffset: number, columnOffset: number): Partial<Entry> {
    let lower = 0; let upper = this.#entries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      const entry = this.#entries[middle];
      if (entry === undefined) throw invalid("mapping index");
      if (lineOffset < entry.generatedLine || (lineOffset === entry.generatedLine && columnOffset < entry.generatedColumn)) upper = middle;
      else lower = middle + 1;
    }
    const entry = this.#entries[lower - 1];
    return entry === undefined ? {} : { ...entry };
  }

  findOrigin(lineNumber: number, columnNumber: number) {
    const entry = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (entry.originalSource === undefined || entry.originalLine === undefined || entry.originalColumn === undefined
      || entry.generatedLine === undefined || entry.generatedColumn === undefined) return {};
    return { name: entry.name, fileName: entry.originalSource,
      lineNumber: entry.originalLine + lineNumber - entry.generatedLine,
      columnNumber: entry.originalColumn + columnNumber - entry.generatedColumn };
  }

  #append(value: unknown, lineOffset: number, columnOffset: number, depth: number): void {
    if (depth > 16) throw new VMError("QUOTA_EXCEEDED", "Source-map section depth exhausted", { api: "module.SourceMap" });
    if (++this.#mapCount > MAX_ENTRIES) throw new VMError("QUOTA_EXCEEDED", "Source-map section budget exhausted", { api: "module.SourceMap" });
    const map = object(value);
    if (map["version"] !== 3) throw invalid("version");
    const sections = map["sections"];
    if (sections !== undefined) {
      if (!Array.isArray(sections) || sections.length > MAX_ENTRIES) throw invalid("sections");
      for (const item of sections) {
        const section = object(item); const offset = object(section["offset"]);
        const line = index(offset["line"]); const column = index(offset["column"]);
        this.#append(section["map"], index(lineOffset + line), index(column + (line === 0 ? columnOffset : 0)), depth + 1);
      }
      return;
    }
    const sources = sourceNames(map["sources"]); const names = map["names"] === undefined ? [] : strings(map["names"]);
    const mappings = map["mappings"];
    if (typeof mappings !== "string") throw invalid("mappings");
    validateVLQ(mappings);
    const decoded = decodedMappings(new TraceMap({ version: 3, sources, names, mappings }));
    let source = 0; let originalLine = 0; let originalColumn = 0; let nameIndex = 0;
    for (const [line, segments] of decoded.entries()) for (const [position, segment] of segments.entries()) {
      if (this.#entries.length >= MAX_MAPPINGS) throw new VMError("QUOTA_EXCEEDED", "Source-map mapping budget exhausted", { api: "module.SourceMap" });
      const generatedColumn = index(index(segment[0]) + (line === 0 ? columnOffset : 0));
      if (segment.length > 1) {
        source = index(segment[1]); originalLine = index(segment[2]); originalColumn = index(segment[3]);
        if (sources[source] === undefined) throw invalid("source index");
      }
      if (segment.length === 5) {
        nameIndex = index(segment[4]);
        if (names[nameIndex] === undefined) throw invalid("name index");
      }
      // Node 24 treats absent trailing fields at EOF as zero deltas. Preserve
      // this public API behavior without changing the original map payload.
      const eof = line === decoded.length - 1 && position === segments.length - 1 && !mappings.endsWith(";");
      const mapped = segment.length > 1 || eof;
      const originalSource = mapped ? sources[source] : undefined;
      const name = segment.length === 5 || eof ? names[nameIndex] : undefined;
      this.#entries.push({ generatedLine: index(lineOffset + line), generatedColumn,
        originalSource, name, originalLine: mapped ? originalLine : undefined,
        originalColumn: mapped ? originalColumn : undefined });
    }
  }
}

function invalid(field: string): TypeError { return new TypeError(`Invalid source-map ${field}`); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("object");
  return record(value, "source map");
}
function copyPayload(value: unknown): Record<string, unknown> {
  const copy = { ...object(value) };
  for (const key of Object.keys(copy)) {
    const item = copy[key];
    if (Array.isArray(item)) { const values: readonly unknown[] = item; copy[key] = [...values]; }
  }
  return copy;
}
function index(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid("index");
  return value;
}
function sourceNames(value: unknown): (string | null)[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw invalid("sources");
  return value.map((item: unknown) => {
    if (item !== null && typeof item !== "string") throw invalid("source");
    return item;
  });
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw invalid("strings");
  return value.map((item: unknown) => { if (typeof item !== "string") throw invalid("string"); return item; });
}
function validateVLQ(mappings: string): void {
  if (mappings.length > MAX_MAP_BYTES) throw new VMError("QUOTA_EXCEEDED", "Source-map encoded budget exhausted", { api: "module.SourceMap" });
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let continued = false;
  let fields = 0; let separators = 0;
  function finish(): void {
    if (continued || (fields !== 0 && fields !== 1 && fields !== 4 && fields !== 5)) throw invalid("VLQ segment");
    fields = 0;
  }
  for (const char of mappings) {
    if (char === "," || char === ";") {
      if (char === "," && fields === 0) throw invalid("empty segment");
      finish();
      if (++separators >= MAX_MAPPINGS) throw new VMError("QUOTA_EXCEEDED", "Source-map decoded budget exhausted", { api: "module.SourceMap" });
      continue;
    }
    const value = alphabet.indexOf(char);
    if (value === -1) throw invalid("VLQ character");
    continued = (value & 32) !== 0;
    if (!continued) fields += 1;
  }
  finish();
  if (mappings.endsWith(",")) throw invalid("empty segment");
}
