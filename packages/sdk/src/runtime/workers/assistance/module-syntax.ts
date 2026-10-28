import { parse } from "@babel/parser";
import * as traversalNamespace from "@babel/traverse";
import * as generatorNamespace from "@babel/generator";
import type { TraverseOptions } from "@babel/traverse";
import type { File } from "@babel/types";
import { record, string } from "../../decode.ts";

/** CJS and browser bundlers expose Babel's default exports differently. */
function entry(namespace: unknown): (...args: unknown[]) => unknown {
  let value = namespace;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof value === "function") {
      const fn = value;
      return (...args): unknown => Reflect.apply(fn, undefined, args);
    }
    value = record(value, "Babel module")["default"];
  }
  throw new TypeError("Babel module has no callable default export");
}

export function parseModule(source: string, filename: string, sourceType: "module" | "script" = "module"): File {
  return parse(source, { sourceType, sourceFilename: filename, allowReturnOutsideFunction: sourceType === "script" });
}

export function traverseModule(tree: File, visitor: TraverseOptions): void {
  entry(traversalNamespace)(tree, visitor);
}

export function printModule(tree: File, source: string, filename: string, inputSourceMap?: string) {
  const result = record(entry(generatorNamespace)(tree, {
    sourceMaps: true, sourceFileName: filename,
    ...(inputSourceMap === undefined ? {} : { inputSourceMap: record(JSON.parse(inputSourceMap) as unknown, "input source map") }),
  }, source), "Babel generated module");
  const map = record(result["map"], "Babel source map");
  if (map["version"] !== 3) throw new TypeError("Babel returned an unsupported source map");
  return { code: string(result["code"], "Babel generated code"), map: JSON.stringify(map) };
}
