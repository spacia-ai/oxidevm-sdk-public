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
}

const ambiguous = Symbol("ambiguous export");

export function createModuleRecord(path: string, definition: ModuleBindings, format: ModuleFormat, jsonValue?: unknown): ModuleRecord {
  return { path, format, jsonValue, definition, dependencies: new Map(), locals: new Map(definition.exports.map(
    binding => [binding.local, new ModuleCell(binding.local)],
  )), exports: new Map(), imports: new Map(), namespace: undefined, linked: false };
}

export function linkModuleGraph(records: Iterable<ModuleRecord>): void {
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
      if (!module.exports.has(forward.exported)) throw new SyntaxError(`Missing or ambiguous export '${forward.imported}' from ${forward.source}`);
    }
    for (const binding of module.definition.imports) {
      const dependency = requiredDependency(module, binding.source);
      const cell = binding.imported === null ? undefined : dependency.exports.get(binding.imported);
      if (binding.imported !== null && cell === undefined) throw new SyntaxError(`Missing or ambiguous export '${binding.imported}' from ${binding.source}`);
      module.imports.set(binding.local, {
        get value(): unknown { return cell === undefined ? dependency.namespace : cell.read(); },
        set value(_value: unknown) { throw new TypeError("Assignment to constant variable."); },
      });
    }
  }
  for (const module of modules) module.linked = true;
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
