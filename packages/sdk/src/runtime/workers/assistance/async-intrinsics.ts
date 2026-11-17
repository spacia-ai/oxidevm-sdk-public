import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { parseModule, printModule, traverseModule } from "./module-syntax.js";
import type { TransformedSource } from "./compiler.js";

/** Empty async functions and generators contain no continuation to schedule. Preserve their native
 * function/iterator prototypes instead of exposing the compiler helper's: a program reaches the
 * AsyncFunction constructor through `(async function () {}).constructor` (Vite's module runner does). */
export function preserveEmptyAsyncFunctions(source: string, filename: string, format: "commonjs" | "module", inputSourceMap?: string) {
  const expressions = new Map<string, t.FunctionExpression | t.ArrowFunctionExpression>();
  let prepared = { code: source, map: inputSourceMap };
  // Comments can separate either keyword. Other modules need no second syntax walk.
  if (/\basync(?:\s+function\s*(?:\*|\/)|\s*\/|\s*(?:function\s*)?\(\s*\)\s*(?:=>\s*)?\{\s*\})/u.test(source)) {
    const tree = parseModule(source, filename, format === "commonjs" ? "script" : "module");
    const keep = (path: NodePath<t.FunctionExpression> | NodePath<t.ArrowFunctionExpression>): void => {
      const { node } = path, { body } = node;
      if (!node.async || node.params.length !== 0 || !t.isBlockStatement(body) || body.body.length !== 0 || body.directives.length !== 0) return;
      const identifier = path.scope.generateUidIdentifier(`nativeAsyncFunction${expressions.size + 1}`);
      expressions.set(identifier.name, t.cloneNode(node, true));
      path.replaceWith(t.inherits(t.callExpression(identifier, []), node));
      path.skip();
    };
    traverseModule(tree, { FunctionExpression: keep, ArrowFunctionExpression: keep });
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
      if (restored !== expressions.size) throw new TypeError("Compiler lost an empty async-function identity");
      return printModule(tree, transformed.code, filename, transformed.map);
    },
  };
}
