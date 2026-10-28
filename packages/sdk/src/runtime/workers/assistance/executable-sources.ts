import { loadApplicationSourceMap } from "./application-source-map.ts";
import { createNodeUrl } from "./node-url.ts";
import { VMError } from "../../errors.ts";
import type { TransformedSource } from "./compiler.ts";
import { SourceMap } from "./node-source-map.ts";

export type ExecutableRole = "commonjs" | "module-implementation" | "module-registration" | "generated-function" | "script";
type ExecutableMapping = { readonly path: string; readonly role: ExecutableRole } & (
  { readonly kind: "identity"; readonly application: SourceMap | undefined; readonly wrapperLines: number } |
  { readonly kind: "mapped"; readonly map: SourceMap; readonly application: SourceMap | undefined; readonly wrapperLines: number }
);

/** One process owns the maps for its evaluated bodies. Compilation identities
 * remain distinct across ESM lowering passes and require.cache invalidation. */
export class ExecutableSources {
  readonly #maps = new Map<string, ExecutableMapping>();
  #mapCharacters = 0;
  readonly #application = new Map<string, { module: SourceMap | undefined; generated: SourceMap | undefined }>();
  readonly #read: (path: string) => string;
  #support = support(false, false, false);
  readonly #urls: ReturnType<typeof createNodeUrl>;

  constructor(read: (path: string) => string = () => { throw new VMError("FEATURE_NOT_AVAILABLE", "Source-map reads need the Linux file owner"); }, cwd: () => string = () => "/") {
    this.#read = read;
    this.#urls = createNodeUrl(cwd);
  }

  getSourceMapsSupport() { return this.#support; }

  setSourceMapsSupport(enabled: unknown, options: unknown = {}): void {
    if (typeof enabled !== "boolean" || typeof options !== "object" || options === null || Array.isArray(options)) throw invalidSupport();
    const nodeModules: unknown = Reflect.get(options, "nodeModules");
    const generatedCode: unknown = Reflect.get(options, "generatedCode");
    if ((nodeModules !== undefined && typeof nodeModules !== "boolean") || (generatedCode !== undefined && typeof generatedCode !== "boolean")) throw invalidSupport();
    this.#support = support(enabled, nodeModules ?? false, generatedCode ?? false);
  }

  registerApplication(path: string, content: string, generated = false): void {
    if (!this.#support.enabled || (!this.#support.nodeModules && path.split("/").includes("node_modules"))
      || (generated && !this.#support.generatedCode)) return;
    let alias: string | undefined;
    for (const match of content.matchAll(/\/[/*]#\s+sourceURL=(\S+)/gu)) alias = match[1];
    if (generated && alias === undefined) return;
    const key = this.#urls.pathToFileURL(path).href;
    const map = loadApplicationSourceMap(generated && alias !== undefined ? this.#key(alias) : path, content, this.#read);
    if (map === undefined) {
      const previous = this.#application.get(key);
      if (previous !== undefined) {
        if (generated) previous.generated = undefined; else previous.module = undefined;
      }
      return;
    }
    const characters = JSON.stringify(map.payload).length;
    if (this.#application.size + (alias === undefined ? 1 : 2) > 65_536 || this.#mapCharacters + characters > 64 * 1024 * 1024) {
      throw new VMError("QUOTA_EXCEEDED", "Application source-map registry budget exhausted", { path });
    }
    this.#mapCharacters += characters;
    for (const identity of alias === undefined ? [key] : [key, this.#key(alias)]) {
      const entry = this.#application.get(identity) ?? { module: undefined, generated: undefined };
      if (generated) entry.generated = map; else entry.module = map;
      this.#application.set(identity, entry);
    }
  }

  findSourceMap(path: unknown): SourceMap | undefined {
    if (this.#application.size === 0) return undefined;
    if (typeof path !== "string" || path.startsWith("node:")
      || (!this.#support.nodeModules && path.split("/").includes("node_modules"))) return undefined;
    const entry = this.#application.get(this.#key(path));
    return entry?.module ?? entry?.generated;
  }

  #key(path: string): string {
    return URL.canParse(path) ? path : this.#urls.pathToFileURL(path).href;
  }

  emitScript(source: string, path: string, role: "script" | "commonjs" = "script"): string {
    if (this.#maps.size >= 65_536 || this.#mapCharacters + source.length > 64 * 1024 * 1024) {
      throw new VMError("QUOTA_EXCEEDED", "Executable source-map budget exhausted", { path, role });
    }
    const url = `oxidevm:compiled/${this.#maps.size + 1}/${encodeURIComponent(path)}`;
    this.#maps.set(url, { path, role, kind: "identity", application: role === "commonjs" ? this.findSourceMap(path) : undefined, wrapperLines: role === "commonjs" ? 2 : 0 });
    this.#mapCharacters += source.length;
    return `${role === "commonjs" ? normalizeExecutableSource(source) : source}\n//# sourceURL=${url}`;
  }

  emit(source: TransformedSource, path: string, role: ExecutableRole): string {
    if (this.#maps.size >= 65_536 || this.#mapCharacters + source.map.length > 64 * 1024 * 1024) {
      throw new VMError("QUOTA_EXCEEDED", "Executable source-map budget exhausted", { path, role });
    }
    const payload: unknown = JSON.parse(source.map);
    let map: SourceMap;
    try { map = new SourceMap(payload); }
    catch (error) {
      if (error instanceof VMError) throw new VMError(error.code, error.message, { ...error.detail, path, role });
      throw error;
    }
    const url = `oxidevm:compiled/${this.#maps.size + 1}/${encodeURIComponent(path)}`;
    const wrapperLines = role === "script" ? 0 : 2;
    this.#maps.set(url, { path, role, kind: "mapped", map, application: this.findSourceMap(path), wrapperLines });
    this.#mapCharacters += source.map.length;
    // Function's implicit wrapper adds two lines. Keep its map in original
    // compiler coordinates and account for that wrapper only during lookup.
    const inlineMap = JSON.stringify({ version: 3, sections: [{ offset: { line: wrapperLines, column: 0 }, map: payload }] });
    return `${normalizeExecutableSource(source.code)}\n//# sourceURL=${url}\n//# sourceMappingURL=data:application/json;charset=utf-8,${encodeURIComponent(inlineMap)}`;
  }

  find(url: string, line: number, column: number): { readonly path: string; readonly role: ExecutableRole; readonly origin: ReturnType<SourceMap["findEntry"]> } | undefined {
    const entry = this.#maps.get(url);
    if (entry === undefined) return undefined;
    const originalLine = line - 1 - entry.wrapperLines;
    let origin: ReturnType<SourceMap["findEntry"]> = entry.kind === "identity"
      ? originalLine < 0 ? {} : { originalSource: entry.path, generatedLine: originalLine, generatedColumn: column - 1, originalLine, originalColumn: column - 1 }
      : entry.map.findEntry(originalLine, column - 1);
    if (this.#support.enabled && entry.application !== undefined
      && (this.#support.nodeModules || !entry.path.split("/").includes("node_modules"))
      && origin.originalLine !== undefined && origin.originalColumn !== undefined) {
      const application = entry.application.findEntry(origin.originalLine, origin.originalColumn);
      if (typeof application.originalSource === "string") origin = application;
    }
    return { path: entry.path, role: entry.role, origin };
  }
}

const sliceSource: unknown = Reflect.get(String.prototype, "slice"), applySource = Reflect.apply;
/** Keep hashbang normalization independent of application string and regexp hooks. */
export function normalizeExecutableSource(source: string): string {
  if (source.length < 2 || source[0] !== "#" || source[1] !== "!") return source;
  if (typeof sliceSource !== "function") throw new TypeError("Missing executable source normalizer");
  const tail: unknown = applySource(sliceSource, source, [2]);
  if (typeof tail !== "string") throw new TypeError("Invalid executable source normalization");
  return "//" + tail;
}

function support(enabled: boolean, nodeModules: boolean, generatedCode: boolean) {
  const value = { enabled, nodeModules, generatedCode };
  Object.setPrototypeOf(value, null);
  return Object.freeze(value);
}
function invalidSupport(): TypeError {
  return Object.assign(new TypeError("Source-map support requires boolean enabled/options"), { code: "ERR_INVALID_ARG_TYPE" });
}
