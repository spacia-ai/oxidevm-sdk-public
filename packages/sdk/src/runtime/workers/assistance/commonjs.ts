import { record, string } from "../../decode.ts";
import { VMError } from "../../errors.ts";
import { createNodePath } from "./node-path.ts";
import { fileURLToPath } from "./node-url.ts";
import type { LocalModuleFiles } from "./module-files.ts";
import type { ExecutableSources } from "./executable-sources.ts";
import { SourceMap } from "./node-source-map.ts";

// API classification from managed Node 24.18.1; the differential test pins this
// list. Classification is not admission: unavailable implementations still fail.
const NODE_BUILTINS = [
  "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server",
  "_stream_duplex", "_stream_passthrough", "_stream_readable", "_stream_transform", "_stream_wrap", "_stream_writable",
  "_tls_common", "_tls_wrap", "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises",
  "http", "http2", "https", "inspector", "inspector/promises", "module", "net", "os", "path", "path/posix", "path/win32",
  "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "repl", "stream", "stream/consumers",
  "stream/promises", "stream/web", "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events", "tty",
  "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib", "node:sea", "node:sqlite", "node:test", "node:test/reporters",
];

export interface CommonJSRecord {
  exports: unknown;
  readonly filename: string | undefined;
}

export function isNodeBuiltin(request: unknown): boolean {
  return typeof request === "string" && (NODE_BUILTINS.includes(request)
    || (request.startsWith("node:") && NODE_BUILTINS.includes(request.slice(5))));
}

/** The module builtin and require hooks share this process's cache and records.
 * Hooks run as application code; they cannot bypass the file owner's admission. */
export function createCommonJSLoader(
  files: LocalModuleFiles,
  builtins: Record<string, object>,
  resolve: (request: unknown, parent?: string) => string,
  admit: (filename: string) => void,
  compile: (source: string, filename: string, module: CommonJSRecord, require: (request: unknown) => unknown) => unknown,
  context: { readonly cwd: () => string; readonly sources: ExecutableSources },
) {
  const paths = createNodePath(context.cwd);
  function dictionary(): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    Object.setPrototypeOf(value, null);
    return value;
  }
  let main: Module | undefined;
  // This index only finds already admitted entries in Module._cache. It never
  // caches exports, failed lookups or mutable filesystem metadata.
  const loadedRequests = new Map<string, string>();
  class Module implements CommonJSRecord {
    static _cache = dictionary();
    static _extensions = dictionary();
    static Module = Module;
    static SourceMap = SourceMap;
    static findSourceMap = (path: unknown) => context.sources.findSourceMap(path);
    static getSourceMapsSupport = () => context.sources.getSourceMapsSupport();
    static setSourceMapsSupport = (enabled: unknown, options?: unknown) => context.sources.setSourceMapsSupport(enabled, options);
    static builtinModules = Object.freeze([...NODE_BUILTINS]);
    readonly id: string;
    path: string;
    exports: unknown = {};
    filename: string | undefined;
    loaded = false;
    readonly children: Module[] = [];
    readonly parent: Module | null;
    paths: string[] = [];

    constructor(id = "", parent: Module | null = null) {
      this.id = id;
      this.path = paths.dirname(id);
      this.parent = parent;
      parent?.children.push(this);
    }

    static _nodeModulePaths(from: string): string[] {
      let directory = paths.resolve(from);
      const result: string[] = [];
      for (;;) {
        if (paths.basename(directory) !== "node_modules") result.push(paths.join(directory, "node_modules"));
        if (directory === "/") return result;
        directory = paths.dirname(directory);
      }
    }

    static _resolveFilename(request: unknown, parent?: Module | null, isMain = false, options?: unknown): string {
      if (typeof isMain !== "boolean") throw new TypeError("Module resolution requires a boolean main flag");
      const builtin = Module.isBuiltin(request);
      const search: unknown = !builtin && typeof options === "object" && options !== null ? Reflect.get(options, "paths") : undefined;
      const filename = builtin || search === undefined ? resolve(request, parent?.filename) : resolveFromPaths(request, search);
      return filename.startsWith("node:") && typeof request === "string" ? request : filename;
    }

    static _load(request: unknown, parent?: Module | null, isMain = false): unknown {
      const key = typeof request === "string" && Module._resolveFilename === defaultResolve
        ? JSON.stringify([context.cwd(), parent?.filename, request, isMain]) : undefined;
      const previous = key === undefined ? undefined : loadedRequests.get(key);
      if (previous !== undefined) {
        const cached: unknown = Module._cache[previous];
        if (cached !== undefined) return cachedExports(cached, parent);
        if (key !== undefined) loadedRequests.delete(key);
      }
      const filename = string(Module._resolveFilename(request, parent, isMain), "resolved filename");
      const name = filename.startsWith("node:") ? filename.slice(5) : filename;
      const builtin = Object.hasOwn(builtins, name) ? builtins[name] : undefined;
      if (builtin !== undefined && filename.startsWith("node:")) return builtin;
      if (builtin === undefined) admit(filename);
      if (key !== undefined && builtin === undefined) {
        if (loadedRequests.size >= 65_536) loadedRequests.clear();
        loadedRequests.set(key, filename);
      }
      const cached: unknown = Module._cache[filename];
      if (cached !== undefined) return cachedExports(cached, parent);
      if (builtin !== undefined) return builtin;
      const module = new Module(isMain ? "." : filename, parent ?? null);
      Module._cache[filename] = module;
      if (isMain) main = module;
      try { module.load(filename); return module.exports; }
      catch (error) {
        Reflect.deleteProperty(Module._cache, filename);
        if (key !== undefined) loadedRequests.delete(key);
        if (parent !== undefined && parent !== null) {
          const index = parent.children.indexOf(module);
          if (index !== -1) parent.children.splice(index, 1);
        }
        if (main === module) main = undefined;
        throw error;
      }
    }

    static createRequire(filename: string | URL) {
      let path: string;
      if (filename instanceof URL || (typeof filename === "string" && filename.startsWith("file:"))) {
        path = fileURLToPath(filename);
      } else path = filename;
      if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) throw new TypeError("createRequire requires an absolute filename");
      if (path.endsWith("/")) path += "noop.js";
      const module = new Module(path);
      module.filename = path;
      module.paths = Module._nodeModulePaths(paths.dirname(path));
      return makeRequire(module);
    }

    static isBuiltin(request: unknown): boolean {
      return isNodeBuiltin(request);
    }

    require(request: unknown): unknown { return Module._load(request, this); }

    load(filename: string): void {
      admit(filename);
      if (this.loaded) throw new Error("Module is already loaded");
      this.filename = filename;
      this.path = paths.dirname(filename);
      this.paths = Module._nodeModulePaths(this.path);
      const extension = paths.extname(filename);
      const handler: unknown = Module._extensions[extension] ?? Module._extensions[".js"];
      if (typeof handler !== "function") throw new TypeError(`Invalid CommonJS extension handler: ${extension}`);
      Reflect.apply(handler, Module._extensions, [this, filename]);
      this.loaded = true;
    }

    _compile(source: string, filename: string): unknown {
      if (typeof source !== "string" || typeof filename !== "string") throw new TypeError("Module._compile requires source and filename strings");
      admit(filename);
      return compile(source, filename, this, makeRequire(this));
    }
  }
  const defaultResolve: unknown = Reflect.get(Module, "_resolveFilename");

  function cachedExports(cached: unknown, parent: Module | null | undefined): unknown {
    if (cached instanceof Module && parent !== undefined && parent !== null && !parent.children.includes(cached)) parent.children.push(cached);
    return record(cached, "require.cache entry")["exports"];
  }

  function resolveFromPaths(request: unknown, search: unknown): string {
    if (!Array.isArray(search)) throw Object.assign(new TypeError("options.paths must be an array"), { code: "ERR_INVALID_ARG_VALUE" });
    const directories: readonly unknown[] = search;
    if (typeof request === "string" && request.startsWith("/")) {
      for (const directory of directories) {
        if (typeof directory !== "string") throw Object.assign(new TypeError("Resolution paths must be strings"), { code: "ERR_INVALID_ARG_TYPE" });
      }
      return resolve(request);
    }
    for (const directory of directories) {
      if (typeof directory !== "string") throw Object.assign(new TypeError("Resolution paths must be strings"), { code: "ERR_INVALID_ARG_TYPE" });
      try { return resolve(request, paths.join(paths.resolve(directory), "__oxidevm_resolve__.cjs")); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
      }
    }
    throw Object.assign(new Error(`Cannot find module '${string(request, "module specifier")}'`), { code: "MODULE_NOT_FOUND" });
  }

  function makeRequire(module: Module) {
    return Object.assign((request: unknown) => module.require(request), {
      resolve: (request: unknown, options?: unknown) => Module._resolveFilename(request, module, false, options),
      cache: Module._cache,
      extensions: Module._extensions,
      main,
    });
  }
  Module._extensions[".js"] = (module: Module, filename: string) => {
    const input = files.read(filename);
    if (input.format === "module") throw unsupported("synchronous ESM loading");
    module._compile(input.source, filename);
  };
  Module._extensions[".json"] = (module: Module, filename: string) => {
    module.exports = JSON.parse(files.read(filename).source.replace(/^\uFEFF/u, "")) as unknown;
  };
  Module._extensions[".node"] = (module: Module, filename: string) => {
    if (files.loadNative === undefined) throw unsupported("native addons");
    module.exports = files.loadNative(filename);
  };
  // Named builtin ESM exports are derived from enumerable properties, just as
  // for the other owned builtin adapters. Class methods default to hidden.
  for (const name of ["createRequire", "isBuiltin"]) Object.defineProperty(Module, name, { enumerable: true });
  builtins["module"] = Module;
  return {
    Module,
    createEvalEntry() {
      const name = "[worker eval]";
      const module = new Module(name);
      module.filename = paths.join(context.cwd(), name);
      module.paths = Module._nodeModulePaths(context.cwd());
      return { module, exports: module.exports, require: makeRequire(module), __filename: name, __dirname: "." };
    },
    importJSON(filename: string, source: string): unknown {
      admit(filename);
      const cached: unknown = Module._cache[filename];
      if (cached !== undefined && record(cached, "require.cache entry")["loaded"] === true) {
        return record(cached, "require.cache entry")["exports"];
      }
      // ESM JSON translation does not invoke application require.extensions.
      // Publish only after parsing; require() then receives this exact object.
      const value: unknown = JSON.parse(source.replace(/^\uFEFF/u, ""));
      const module = new Module(filename);
      module.filename = filename;
      module.exports = value;
      module.loaded = true;
      Module._cache[filename] = module;
      return value;
    },
    require: (request: unknown, parent?: string): unknown => parent === undefined
      ? Module._load(request, undefined, main === undefined)
      : Module.createRequire(parent)(request),
  };
}

function unsupported(operation: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", `${operation} is not available`, { backend: "assisted-node" });
}
