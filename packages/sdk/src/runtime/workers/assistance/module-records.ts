import { record } from "../../decode.ts";
import type { ModuleBindings } from "./module-bindings.ts";
import type { ModuleFormat } from "./module-files.ts";

/** A getter closes over a native lexical scope, including its native TDZ. */
export class ModuleCell {
  #getter: (() => unknown) | undefined;
  readonly name: string;
  constructor(name: string) { this.name = name; }
  bind(getter: () => unknown): void {
    if (this.#getter !== undefined) throw new TypeError(`module binding already bound: ${this.name}`);
    this.#getter = getter;
  }
  read(): unknown {
    if (this.#getter === undefined) throw new ReferenceError(`Cannot access '${this.name}' before initialization`);
    return this.#getter();
  }
}

/** Where a module is in its one evaluation, shared by `import()` (SystemJS orders it) and `require()` (the
 * synchronous evaluator orders it), so a module runs once whichever asks first. */
export type ModuleEvaluation =
  | { readonly status: "new" }
  | { readonly status: "evaluating" }
  | { readonly status: "pending"; readonly promise: Promise<unknown> }
  | { readonly status: "evaluated" }
  | { readonly status: "failed"; readonly error: unknown };

export interface ModuleRecord {
  readonly path: string;
  readonly format: ModuleFormat;
  /** JSON's ESM snapshot survives replacement of its shared CJS cache entry. */
  readonly jsonValue: unknown;
  readonly definition: ModuleBindings;
  readonly dependencies: Map<string, ModuleRecord>;
  readonly locals: Map<string, ModuleCell>;
  readonly exports: Map<string, ModuleCell>;
  readonly imports: Map<string, { readonly value: unknown }>;
  namespace: Record<string, unknown> | undefined;
  linked: boolean;
  evaluation: ModuleEvaluation;
  /** The file whose `require()` first evaluated this module synchronously; Node names it in a cycle error. */
  requiredBy: string | undefined;
  /** What `require()` returns, once computed: Node returns the same object every time. */
  commonJSView: unknown;
}

const ambiguous = Symbol("ambiguous export");

export function createModuleRecord(path: string, definition: ModuleBindings, format: ModuleFormat, jsonValue?: unknown): ModuleRecord {
  return { path, format, jsonValue, definition, dependencies: new Map(), locals: new Map(definition.exports.map(
    binding => [binding.local, new ModuleCell(binding.local)],
  )), exports: new Map(), imports: new Map(), namespace: undefined, linked: false,
    evaluation: { status: "new" }, requiredBy: undefined, commonJSView: undefined };
}

/** Explains why `module` lacks `name` for `importer`, when the program is not at fault. */
export type MissingExport = (module: ModuleRecord, name: string, importer: ModuleRecord) => Error | undefined;

export function linkModuleGraph(records: Iterable<ModuleRecord>, explain: MissingExport = () => undefined): void {
  const modules = Array.from(records);
  for (const module of modules) {
    if (module.linked) continue;
    for (const name of exportNames(module, new Set())) {
      const cell = resolveExport(module, name, new Set());
      if (cell !== undefined && cell !== ambiguous) module.exports.set(name, cell);
    }
    module.namespace = namespace(module.exports);
  }
  for (const module of modules) {
    if (module.linked) continue;
    for (const forward of module.definition.forwards) {
      if (!module.exports.has(forward.exported)) throw unresolved(module, forward.source, forward.imported, explain);
    }
    for (const binding of module.definition.imports) {
      const dependency = requiredDependency(module, binding.source);
      const cell = binding.imported === null ? undefined : dependency.exports.get(binding.imported);
      if (binding.imported !== null && cell === undefined) throw unresolved(module, binding.source, binding.imported, explain);
      module.imports.set(binding.local, {
        get value(): unknown { return cell === undefined ? dependency.namespace : cell.read(); },
        set value(_value: unknown) { throw new TypeError("Assignment to constant variable."); },
      });
    }
  }
  for (const module of modules) module.linked = true;
}

/** A name no module provides is the program's SyntaxError, unless `explain` blames the module
 * that would provide it through re-exports; an ambiguous name stays the program's error. */
function unresolved(importer: ModuleRecord, source: string, name: string | null, explain: MissingExport): Error {
  const dependency = requiredDependency(importer, source);
  const cause = name === null || resolveExport(dependency, name, new Set()) === ambiguous
    ? undefined : lacking(dependency, name, importer, explain, new Set());
  return cause ?? new SyntaxError(`Missing or ambiguous export '${name}' from ${source}`);
}

function lacking(module: ModuleRecord, name: string, importer: ModuleRecord, explain: MissingExport, visited: Set<string>): Error | undefined {
  const key = JSON.stringify([module.path, name]);
  if (visited.has(key) || module.definition.exports.some(binding => binding.exported === name)) return undefined;
  visited.add(key);
  const forward = module.definition.forwards.find(binding => binding.exported === name);
  if (forward !== undefined) {
    return forward.imported === null ? undefined : lacking(requiredDependency(module, forward.source), forward.imported, importer, explain, visited);
  }
  const cause = explain(module, name, importer);
  if (cause !== undefined || name === "default") return cause;
  for (const source of module.definition.stars) {
    const star = lacking(requiredDependency(module, source), name, importer, explain, visited);
    if (star !== undefined) return star;
  }
  return undefined;
}

function requiredDependency(module: ModuleRecord, source: string): ModuleRecord {
  const dependency = module.dependencies.get(source);
  if (dependency === undefined) throw new TypeError(`Unprepared module dependency: ${source}`);
  return dependency;
}

function exportNames(module: ModuleRecord, visited: Set<ModuleRecord>): Set<string> {
  if (visited.has(module)) return new Set();
  visited.add(module);
  const names = new Set([...module.definition.exports, ...module.definition.forwards].map(binding => binding.exported));
  for (const source of module.definition.stars) {
    for (const name of exportNames(requiredDependency(module, source), visited)) if (name !== "default") names.add(name);
  }
  return names;
}

function resolveExport(module: ModuleRecord, name: string, visited: Set<string>): ModuleCell | typeof ambiguous | undefined {
  const key = JSON.stringify([module.path, name]);
  if (visited.has(key)) return undefined;
  visited.add(key);
  const own = module.definition.exports.find(binding => binding.exported === name);
  if (own !== undefined) return module.locals.get(own.local);
  const forward = module.definition.forwards.find(binding => binding.exported === name);
  if (forward !== undefined) {
    const dependency = requiredDependency(module, forward.source);
    if (forward.imported !== null) return resolveExport(dependency, forward.imported, visited);
    let cell = module.exports.get(name);
    if (cell === undefined) {
      cell = new ModuleCell(name);
      cell.bind(() => dependency.namespace);
      module.exports.set(name, cell);
    }
    return cell;
  }
  if (name === "default") return undefined;
  let result: ModuleCell | undefined;
  for (const source of module.definition.stars) {
    const cell = resolveExport(requiredDependency(module, source), name, new Set(visited));
    if (cell === ambiguous || (cell !== undefined && result !== undefined && cell !== result)) return ambiguous;
    result ??= cell;
  }
  return result;
}

function namespace(cells: ReadonlyMap<string, ModuleCell>): Record<string, unknown> {
  const target = record(Object.create(null), "empty module namespace");
  const names = Array.from(cells.keys()).sort();
  for (const name of names) Object.defineProperty(target, name, { value: undefined, writable: true, enumerable: true, configurable: false });
  Object.defineProperty(target, Symbol.toStringTag, { value: "Module" });
  Object.preventExtensions(target);
  return new Proxy(target, {
    get(object, key): unknown { return typeof key === "string" && cells.has(key) ? cells.get(key)?.read() : Reflect.get(object, key); },
    getOwnPropertyDescriptor(object, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      return descriptor !== undefined && typeof key === "string" && cells.has(key)
        ? { ...descriptor, value: cells.get(key)?.read() } : descriptor;
    },
    set() { return false; },
    defineProperty(_object, key, descriptor) {
      if (typeof key === "symbol") return Reflect.defineProperty(target, key, descriptor);
      const cell = typeof key === "string" ? cells.get(key) : undefined;
      return cell !== undefined && descriptor.configurable !== true && descriptor.enumerable !== false &&
        descriptor.writable !== false && descriptor.get === undefined && descriptor.set === undefined &&
        (!("value" in descriptor) || Object.is(descriptor.value, cell.read()));
    },
  });
}

export function bindModuleLocals(module: ModuleRecord, value: unknown): void {
  const getters = record(value, "module binding getters");
  for (const [name, cell] of module.locals) {
    const getter = getters[name];
    if (typeof getter !== "function") throw new TypeError(`Missing getter for ${name}`);
    cell.bind(() => Reflect.apply(getter, undefined, []));
  }
}

/** What `require()` of an evaluated ES module returns in Node 24: the value of an export named
 * "module.exports" when there is one; else, when the module has a default export and no `__esModule` export,
 * a namespace of the same exports plus `__esModule: true`; else the module's own namespace. */
export function commonJSView(module: ModuleRecord): unknown {
  if (module.commonJSView !== undefined) return module.commonJSView;
  const explicit = module.exports.get("module.exports");
  let view: unknown;
  if (explicit !== undefined) view = explicit.read();
  else if (module.exports.has("default") && !module.exports.has("__esModule")) {
    const marker = new ModuleCell("__esModule");
    marker.bind(() => true);
    view = namespace(new Map([...module.exports, ["__esModule", marker]]));
  } else view = module.namespace;
  module.commonJSView = view;
  return view;
}
