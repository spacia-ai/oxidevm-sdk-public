import { ExecutableSources, normalizeExecutableSource } from "./executable-sources.ts";
import { record, string } from "../../decode.ts";
import { VMError } from "../../errors.ts";
import { type AssistanceCompiler, transformSource } from "./compiler.ts";
import { lowerModuleBindings } from "./module-bindings.ts";
import { commonJSView, createModuleRecord, linkModuleGraph, type ModuleRecord } from "./module-records.ts";
import { instantiateModule } from "./module-execution.ts";
import { lowerScriptImports } from "./script-imports.ts";
import { lowerEvaluatedSource } from "./evaluated-sources.ts";
import { createCommonJSLoader, isNodeBuiltin } from "./commonjs.ts";
import { commonJSNames, commonJSSource, commonJSValues } from "./commonjs-namespace.ts";
import { importAttributes, validateImportAttributes } from "./import-attributes.ts";
import { createNodeUrl } from "./node-url.ts";
import { typelessPackageWarning } from "./module-detection.ts";
import type { LocalModuleFiles } from "./module-files.ts";
import { realmEvaluator } from "./node-vm.ts";
export type { LocalModuleFiles } from "./module-files.ts";

export interface LocalModuleLoaderOptions {
  readonly onNextMemoryException?: (path: string) => void;
  /** The pinned runtime's exports of each built-in: a named ESM import of one this layer lacks
   * fails before the graph runs, as a late failure the engine remembers (ADR 0026). */
  readonly realExports?: Readonly<Record<string, readonly string[]>>;
}

// Capture before installing the application-facing generated-code adapter.
const Evaluator = Function, syntaxErrorPrototype = SyntaxError.prototype, prototypeOf = Object.getPrototypeOf;

/** One loader per process: module instances are never shared between workers. */
export function createLocalModuleLoader(
  compiler: AssistanceCompiler,
  systemSource: string,
  files: LocalModuleFiles,
  builtinValues: Readonly<Record<string, object>> = {},
  cwd: string | (() => string) = "/",
  { onNextMemoryException, realExports }: LocalModuleLoaderOptions = {},
) {
  const builtins: Record<string, object> = { ...builtinValues };
  const modules = new Map<string, ModuleRecord>();
  const currentDirectory = typeof cwd === "string" ? () => cwd : cwd;
  const urls = createNodeUrl(currentDirectory);
  const sources = new ExecutableSources(path => files.read(path).source, currentDirectory);
  const environment: Record<string, unknown> = {};
  // Fixed, bundled SystemJS artifact. Production callers live only in the
  // isolated process worker; neither the IDE nor control worker evaluates code.
  const bootstrap = new Evaluator("self", "global", systemSource);
  Reflect.apply(bootstrap, undefined, [environment, environment]);
  const system = record(environment["System"], "SystemJS runtime");
  const register = callable(system["register"], "register");
  const getRegister = callable(system["getRegister"], "getRegister");
  const importModule = callable(system["import"], "import");

  function resolve(value: unknown, parent = `${currentDirectory().replace(/\/$/u, "")}/entry.cjs`, kind: "require" | "import" = "require"): string {
    const specifier = string(value, "module specifier");
    const builtin = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (Object.hasOwn(builtins, builtin)) return `node:${builtin}`;
    if (specifier.startsWith("node:") || isNodeBuiltin(specifier)) throw unsupportedBuiltin(specifier, parent);
    if (files.dependencies === undefined && !(specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../") || (kind === "import" && specifier.startsWith("file:")))) {
      throw unsupported(specifier, "installed-package and builtin resolution is not available", parent);
    }
    const path = files.resolve(specifier, parent, kind);
    if (path.startsWith("node:")) {
      if (Object.hasOwn(builtins, path.slice(5))) return path;
      throw unsupportedBuiltin(path, parent);
    }
    admit(path);
    return path;
  }

  function admit(path: string): void {
    if (!path.startsWith("/") || (path.includes("\0") || /[\r\n]/u.test(path))) {
      throw new VMError("PROTOCOL_ERROR", "Guest returned an invalid module path");
    }
    if (files.dependencies === undefined && path.split("/").includes("node_modules")) throw unsupported(path, "installed-package execution is not available");
  }

  const commonjs = createCommonJSLoader(files, builtins, resolve, admit, (sourceText, path, module, require) => {
    const script = lowerScriptImports(sourceText, path, files, code => lowerEvaluatedSource(compiler, code, path));
    sources.registerApplication(path, sourceText);
    if (script.memoryException) onNextMemoryException?.(path);
    const compile = (body: string) => new Evaluator("exports", "require", "module", "__filename", "__dirname", script.importName, body);
    let original = false;
    if (!script.requiresAsyncLowering && script.map === undefined) {
      try {
        // Parsing executes no application code. Unsupported syntax retains the existing compiler path.
        compile(normalizeExecutableSource(script.code));
        original = true;
      } catch (error) {
        if (prototypeOf(error) !== syntaxErrorPrototype) throw error;
      }
    }
    const body = original ? sources.emitScript(script.code, path, "commonjs")
      : sources.emit(transformSource(compiler, script.code, "commonjs", path, script.map), path, "commonjs");
    // ADR 0012: this evaluator is private to the isolated process worker.
    const evaluate = compile(body);
    const result: unknown = Reflect.apply(evaluate, module.exports, [module.exports, require, module, path, path.slice(0, path.lastIndexOf("/")) || "/",
      (specifier: unknown, options?: unknown) => importLocal(specifier, path, options)]);
    return result;
  }, { cwd: currentDirectory, sources, loadModule: (path, requirer) => requireModule(path, requirer) });
  // Node's `module` builtin is the CommonJS Module class itself: packages patch
  // `Module.prototype.require` and `Module._resolveFilename` (Next's require
  // hook aliases React through them), and every nested require routes through
  // `module.require` and `Module._resolveFilename`, so the patches take effect.
  builtins["module"] = commonjs.Module;

  // Node warns once per package.json whose missing "type" made it reparse an imported file as a module.
  const typelessPackages = new Set<string>();
  function warnTypelessPackage(path: string, packageJSON: string): void {
    if (typelessPackages.has(packageJSON)) return;
    typelessPackages.add(packageJSON);
    const process: unknown = Reflect.get(globalThis, "process");
    const emit: unknown = typeof process === "object" && process !== null ? Reflect.get(process, "emitWarning") : undefined;
    if (typeof emit === "function") Reflect.apply(emit, process, [typelessPackageWarning(urls.pathToFileURL(path).href, packageJSON), { code: "MODULE_TYPELESS_PACKAGE_JSON" }]);
  }

  function prepare(path: string, created: string[] = [], attributes: Readonly<Record<string, string>> = {}): ModuleRecord {
    const existing = modules.get(path);
    if (existing !== undefined) {
      // Node's loaded-module identity uses the type attribute (implicit
      // "javascript" for JS), so an existing job skips load-time validation.
      const type = Object.hasOwn(attributes, "type") ? attributes["type"] : "javascript";
      if (type === (existing.format === "json" ? "json" : "javascript")) return existing;
      validateImportAttributes(attributes, existing.format, path);
      return existing;
    }
    const input = path.startsWith("node:")
      ? { source: builtinSource(builtins[path.slice(5)] ?? {}), format: "module" as const }
      : files.read(path, "import");
    validateImportAttributes(attributes, input.format, path);
    if ("typelessPackage" in input) warnTypelessPackage(path, input.typelessPackage);
    if (input.format === "module" && !path.startsWith("node:")) sources.registerApplication(path, input.source);
    const source = input.format === "commonjs"
      ? commonJSSource(commonJSNames(path, input.source, files, resolve))
      : input.format === "json" ? commonJSSource(["default"]) : input.source;
    const module = createModuleRecord(path, lowerModuleBindings(source, path), input.format,
      input.format === "json" ? commonjs.importJSON(path, input.source) : undefined);
    modules.set(path, module);
    created.push(path);
    for (const dependency of module.definition.dependencies) {
      module.dependencies.set(dependency.source, prepare(resolve(dependency.source, path, "import"), created, dependency.attributes));
    }
    return module;
  }

  async function importLocal(specifier: unknown, parent?: string, options?: unknown): Promise<Record<string, unknown>> {
    if (typeof specifier === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    const request = String(specifier);
    const attributes = importAttributes(options);
    const path = resolve(request, parent, "import");
    const created: string[] = [];
    let module: ModuleRecord;
    try {
      module = prepare(path, created, attributes);
    } catch (error) {
      for (const added of created) modules.delete(added);
      throw error;
    }
    const graph = new Set<ModuleRecord>();
    function visit(record: ModuleRecord): void {
      if (graph.has(record)) return;
      graph.add(record);
      for (const dependency of record.dependencies.values()) visit(dependency);
    }
    visit(module);
    linkModuleGraph(graph, (dependency, name, importer) => dependency.path.startsWith("node:") &&
      realExports?.[dependency.path.slice(5)]?.includes(name) === true ? unsupportedExport(dependency.path, name, importer.path) : undefined);
    await Reflect.apply(importModule, system, [path]);
    return record(module.namespace, "module namespace");
  }

  Object.defineProperty(system, "resolve", { value: (specifier: unknown, parent?: string) => resolve(specifier, parent, "import") });
  /** A module's compiled registration and its body, made once: SystemJS and the synchronous evaluator share them. */
  const declarations = new WeakMap<ModuleRecord, { readonly dependencies: string[]; readonly setters: unknown; readonly execute: () => unknown }>();
  function declaration(module: ModuleRecord) {
    const known = declarations.get(module);
    if (known !== undefined) return known;
    const path = module.path;
    const source = transformSource(compiler, module.definition.code, "module", path, module.definition.map);
    const implementation = module.definition.implementation;
    const loweredImplementation = transformSource(compiler, implementation.code, "commonjs", path, implementation.map);
    const evaluateImplementation = new Evaluator("__oxidevm_builtin", "__oxidevm_commonjs", `${sources.emit(loweredImplementation, path, "module-implementation")}\nreturn ${module.definition.factoryName};`);
    const implementationFactory = callable(Reflect.apply(evaluateImplementation, undefined,
      [path.startsWith("node:") ? builtins[path.slice(5)] : undefined,
        () => module.format === "json" ? [module.jsonValue]
          : commonJSValues(commonjs.require(path, path), module.definition.exports.map(binding => binding.exported))]), "implementation factory");
    // No browser URL resolution or script loading: only admitted guest bytes.
    const evaluate = new Evaluator("System", sources.emit(source, path, "module-registration"));
    Reflect.apply(evaluate, undefined, [{ register: (...args: unknown[]) => Reflect.apply(register, system, args) }]);
    const registration: unknown = Reflect.apply(getRegister, system, []);
    if (!Array.isArray(registration) || registration.length !== 3 ||
        !Array.isArray(registration[0]) || !registration[0].every((value: unknown) => typeof value === "string") ||
        typeof registration[1] !== "function" || registration[2] !== undefined) {
      throw new VMError("PROTOCOL_ERROR", "Compiler did not register an ESM module", { path });
    }
    const dependencies: string[] = registration[0].map((value: unknown) => string(value, "module dependency"));
    const declare = callable(registration[1], "declare");
    let factory: unknown;
    const declared = record(Reflect.apply(declare, undefined, [
      (name: unknown, value: unknown) => {
        if (name !== module.definition.factoryName || typeof value !== "function") throw new TypeError("Invalid module factory registration");
        factory = value;
        return value;
      },
      { meta: {}, import: (specifier: unknown, options?: unknown) => importLocal(specifier, path, options) },
    ]), "SystemJS declaration");
    const registeredFactory = callable(factory, "registered factory");
    const execute = instantiateModule(module, (runtime: unknown) => registeredFactory({
      ...record(runtime, "module runtime"),
      dynamicImport: (specifier: unknown, options?: unknown) => importLocal(specifier, path, options),
      meta: path.startsWith("node:") ? { url: path } : {
        url: urls.pathToFileURL(path).href, filename: path, dirname: path.slice(0, path.lastIndexOf("/")) || "/",
        // Node answers at once with a URL; SystemJS's own `meta.resolve` returns a promise of a path.
        resolve: (specifier: unknown) => { const found = resolve(String(specifier), path, "import"); return found.startsWith("node:") ? found : urls.pathToFileURL(found).href; },
      },
    }, implementationFactory));
    const made = { dependencies, setters: declared["setters"], execute };
    declarations.set(module, made);
    return made;
  }
  /** Runs a module's body once. Its dependencies already ran: SystemJS or `evaluateSynchronously` ordered them. */
  function runBody(module: ModuleRecord): unknown {
    const state = module.evaluation;
    if (state.status === "evaluated") return undefined;
    if (state.status === "failed") throw state.error;
    if (state.status === "pending") return state.promise;
    module.evaluation = { status: "evaluating" };
    let result: unknown;
    try { result = declaration(module).execute(); } catch (error) {
      module.evaluation = { status: "failed", error };
      throw error;
    }
    if (!(result instanceof Promise)) {
      module.evaluation = { status: "evaluated" };
      return undefined;
    }
    const promise = result.then(() => { module.evaluation = { status: "evaluated" }; }, (error: unknown) => {
      module.evaluation = { status: "failed", error };
      throw error;
    });
    module.evaluation = { status: "pending", promise };
    return promise;
  }
  const instantiate = (pathValue: unknown): unknown => {
    const path = resolve(pathValue, undefined, "import");
    const module = modules.get(path) ?? prepare(path);
    const declared = declaration(module);
    return [declared.dependencies, (publish: unknown) => {
      const exportCell = callable(publish, "export");
      for (const [name, cell] of module.exports) exportCell(name, cell);
      return { setters: declared.setters, execute: () => runBody(module) };
    }, undefined];
  };
  Object.defineProperty(system, "instantiate", { value: instantiate });

  /** Node 24's `require()` of an ES module: the graph links and runs synchronously, in dependency order. A graph
   * with an unevaluated top-level `await`, or a module this same evaluation has not finished, is refused with
   * Node's errors before any of its modules runs. */
  function requireModule(path: string, requirer: string | undefined): unknown {
    const created: string[] = [];
    let module: ModuleRecord;
    try {
      module = prepare(path, created);
    } catch (error) {
      for (const added of created) modules.delete(added);
      throw error;
    }
    const graph = new Set<ModuleRecord>();
    const visit = (entry: ModuleRecord): void => {
      if (graph.has(entry)) return;
      graph.add(entry);
      for (const dependency of entry.dependencies.values()) visit(dependency);
    };
    visit(module);
    linkModuleGraph(graph, (dependency, name, importer) => dependency.path.startsWith("node:") &&
      realExports?.[dependency.path.slice(5)]?.includes(name) === true ? unsupportedExport(dependency.path, name, importer.path) : undefined);
    if (module.evaluation.status === "evaluating") {
      throw Object.assign(new Error(`Cannot require() ES Module ${path} in a cycle. (from ${String(module.requiredBy ?? requirer)})`), { code: "ERR_REQUIRE_CYCLE_MODULE" });
    }
    if (module.evaluation.status === "pending" || [...graph].some(entry => entry.evaluation.status === "new" && entry.definition.topLevelAwait)) {
      throw Object.assign(new Error("require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the " +
        `top-level await comes from, use --experimental-print-required-tla.\n  From ${String(requirer)} \n  Requiring ${path} `), { code: "ERR_REQUIRE_ASYNC_MODULE" });
    }
    module.requiredBy ??= requirer;
    evaluateSynchronously(module);
    return commonJSView(module);
  }
  function evaluateSynchronously(module: ModuleRecord): void {
    const state = module.evaluation;
    if (state.status === "evaluated" || state.status === "evaluating") return;
    if (state.status === "failed") throw state.error;
    if (state.status === "pending") throw new TypeError(`ES module ${module.path} is still evaluating asynchronously`);
    module.evaluation = { status: "evaluating" };
    try {
      for (const dependency of module.dependencies.values()) evaluateSynchronously(dependency);
    } catch (error) {
      module.evaluation = { status: "failed", error };
      throw error;
    }
    runBody(module);
  }
  return {
    sources,
    require: commonjs.require,
    preload: commonjs.preload,
    import: importLocal,
    evaluateScript(source: string, install: (name: string, value: unknown) => void): unknown {
      const entry = commonjs.createEvalEntry();
      for (const [name, value] of Object.entries(entry)) install(name, value);
      try {
        const script = lowerScriptImports(source, entry.__filename);
        if (script.map !== undefined) install(script.importName, (specifier: unknown, options?: unknown) => importLocal(specifier, entry.module.filename, options));
        // Eval uses script grammar and its original UTF16 text, without Function's wrapper.
        const code = script.map === undefined ? sources.emitScript(script.code, entry.__filename)
          : sources.emit({ code: script.code, map: script.map }, entry.__filename, "script");
        return realmEvaluator()(code, entry.__filename);
      } catch (error) {
        // V8 indirect eval omits the script name when parsing fails.
        if (error instanceof SyntaxError && typeof error.stack === "string" && !error.stack.includes(entry.__filename)) error.stack = `${entry.__filename}\n${error.stack}`;
        throw error;
      }
    },
  };
}

function builtinSource(exports: object): string {
  const declarations = Object.keys(exports).filter((name) => name !== "default").map((name, index) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) throw new TypeError(`Invalid builtin export: ${name}`);
    return `const binding${index} = __oxidevm_builtin[${JSON.stringify(name)}]; export { binding${index} as ${name} };`;
  });
  return `export default __oxidevm_builtin;\n${declarations.join("\n")}`;
}

function callable(value: unknown, name: string): (...args: unknown[]) => unknown {
  if (typeof value !== "function") throw new TypeError(`SystemJS is missing ${name}`);
  return function (this: unknown, ...args: unknown[]): unknown { return Reflect.apply(value, this, args); };
}

function unsupported(path: string, operation: string, importer?: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", operation, { path, backend: "assisted-node", ...(importer === undefined ? {} : { importer }) });
}

/** A real export of a provided built-in the browser layer lacks, imported by name (ADR 0026). */
function unsupportedExport(path: string, name: string, importer: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", "builtin export is not supported", { path, backend: "assisted-node", importer, lateFailure: "unavailable-builtin", subject: `${path}.${name}` });
}

/** A Node built-in the browser layer lacks: Linux has it, so a late failure is remembered (ADR 0026). */
function unsupportedBuiltin(specifier: string, importer: string): VMError {
  const name = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
  return new VMError("FEATURE_NOT_AVAILABLE", "builtin is not supported", { path: specifier, backend: "assisted-node", importer, lateFailure: "unavailable-builtin", subject: name });
}
