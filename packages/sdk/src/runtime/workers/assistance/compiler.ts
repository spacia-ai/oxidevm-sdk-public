import { preserveEmptyAsyncGenerators } from "./async-intrinsics.js";

/** A pinned compiler's callable boundary; dependency values never escape unchecked. */
export interface AssistanceCompiler {
  transform(source: string, options: Readonly<Record<string, unknown>>): TransformedSource;
  hasDynamicImport(source: string): boolean;
}

export interface TransformedSource {
  readonly code: string;
  readonly map: string;
}

/** Instantiate only the compiler module supplied by the trusted bootstrap. */
export function initializeCompiler(namespace: unknown, module: WebAssembly.Module): AssistanceCompiler {
  if (typeof namespace !== "object" || namespace === null ||
      !("initSync" in namespace) || typeof namespace.initSync !== "function") {
    throw new TypeError("assistance compiler is missing its synchronous initializer");
  }
  const compiler = decodeCompiler(namespace);
  Reflect.apply(namespace.initSync, namespace, [{ module }]);
  return compiler;
}

export function decodeCompiler(value: unknown): AssistanceCompiler {
  if (typeof value !== "object" || value === null || !("transformSync" in value)) {
    throw new TypeError("assistance compiler is missing transformSync");
  }
  const transform = value.transformSync;
  if (typeof transform !== "function") {
    throw new TypeError("assistance compiler transformSync must be callable");
  }
  return {
    hasDynamicImport(source) {
      if (!("parseSync" in value) || typeof value.parseSync !== "function") {
        throw new TypeError("assistance compiler is missing parseSync");
      }
      const tree: unknown = Reflect.apply(value.parseSync, value, [source, { syntax: "ecmascript", isModule: false }]);
      if (typeof tree !== "object" || tree === null || !("type" in tree) || tree.type !== "Script") {
        throw new TypeError("assistance compiler returned an invalid script tree");
      }
      const pending: unknown[] = [tree];
      let visited = 0;
      while (pending.length !== 0) {
        if (++visited > 1_000_000) throw new RangeError("script syntax tree exceeds admission limit");
        const node = pending.pop();
        if (typeof node !== "object" || node === null) continue;
        if ("type" in node && node.type === "Import") return true;
        const children: readonly unknown[] = Array.isArray(node) ? node : Object.values(node);
        for (const child of children) pending.push(child);
      }
      return false;
    },
    transform(source, options) {
      const result: unknown = Reflect.apply(transform, value, [source, options]);
      if (
        typeof result !== "object" || result === null ||
        !("code" in result) || typeof result.code !== "string" ||
        !("map" in result) || typeof result.map !== "string"
      ) {
        throw new TypeError("assistance compiler returned invalid code/source map");
      }
      return { code: result.code, map: result.map };
    },
  };
}

/** Node-compatible evaluation happens later, in the isolated process evaluator. */
export function transformSource(
  compiler: AssistanceCompiler,
  source: string,
  format: "commonjs" | "module",
  filename: string,
  inputSourceMap?: string,
): TransformedSource {
  const prepared = preserveEmptyAsyncGenerators(source, filename, format, inputSourceMap);
  source = prepared.code;
  inputSourceMap = prepared.map;
  const common = { filename, sourceMaps: true, swcrc: false, configFile: false };
  const lowered = format === "module"
    ? compiler.transform(source, {
        ...common,
        ...(inputSourceMap === undefined ? {} : { inputSourceMap }),
        jsc: { parser: { syntax: "ecmascript" }, target: "esnext" },
        module: { type: "systemjs" },
      })
    : undefined;
  // Module lowering can introduce async execute() for top-level await. Running
  // this pass last is required even if the original input has no async function.
  return prepared.restore(compiler.transform(lowered?.code ?? source, {
    ...common,
    isModule: format === "module",
    ...((lowered?.map ?? inputSourceMap) === undefined ? {} : { inputSourceMap: lowered?.map ?? inputSourceMap }),
    jsc: { parser: { syntax: "ecmascript" } },
    env: { targets: { chrome: "141" }, include: ["transform-async-to-generator", "transform-async-generator-functions"] },
  }));
}
