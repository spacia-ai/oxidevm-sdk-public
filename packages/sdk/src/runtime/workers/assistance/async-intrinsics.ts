import * as t from "@babel/types";
import { parseModule, printModule, traverseModule } from "./module-syntax.js";
import type { TransformedSource } from "./compiler.js";

/** Empty generators contain no continuation to schedule. Preserve their native
 * function/iterator prototypes instead of exposing the compiler helper's. */
export function preserveEmptyAsyncGenerators(source: string, filename: string, format: "commonjs" | "module", inputSourceMap?: string) {
  const expressions = new Map<string, t.FunctionExpression>();
  let prepared = { code: source, map: inputSourceMap };
  // Comments can separate either keyword. Other modules need no second syntax walk.
  if (/\basync(?:\s+function\s*(?:\*|\/)|\s*\/)/u.test(source)) {
    const tree = parseModule(source, filename, format === "commonjs" ? "script" : "module");
    traverseModule(tree, {
      FunctionExpression(path) {
        if (!path.node.async || !path.node.generator || path.node.params.length !== 0 || path.node.body.body.length !== 0 || path.node.body.directives.length !== 0) return;
        const identifier = path.scope.generateUidIdentifier(`nativeAsyncGenerator${expressions.size + 1}`);
        expressions.set(identifier.name, t.cloneNode(path.node, true));
        path.replaceWith(t.inherits(t.callExpression(identifier, []), path.node));
        path.skip();
      },
    });
    if (expressions.size !== 0) prepared = printModule(tree, source, filename, inputSourceMap);
  }
  return {
    ...prepared,
    restore(transformed: TransformedSource): TransformedSource {
      if (expressions.size === 0) return transformed;
      const tree = parseModule(transformed.code, filename, format === "commonjs" ? "script" : "module");
      let restored = 0;
      traverseModule(tree, {
        CallExpression(path) {
          if (!t.isIdentifier(path.node.callee) || path.node.arguments.length !== 0) return;
          const original = expressions.get(path.node.callee.name);
          if (original === undefined) return;
          path.replaceWith(t.inherits(t.cloneNode(original, true, true), path.node));
          path.skip(); restored++;
        },
      });
      if (restored !== expressions.size) throw new TypeError("Compiler lost an empty async-generator identity");
      return printModule(tree, transformed.code, filename, transformed.map);
    },
  };
}
