import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { traverseModule, printModule } from "./module-syntax.ts";
import { applyNextMemoryException } from "./next-memory.ts";
import type { LocalModuleFiles } from "./module-files.ts";
import { lowerAsyncSuper } from "./async-super.js";

/** CommonJS import() must never invoke the browser's native module loader. */
/** `lowerEvaluated` receives the literal source of each direct `eval` call and returns its replacement, or undefined to
 * keep it: the source such a call runs never crosses the loader on its own. */
export function lowerScriptImports(source: string, filename: string, files?: LocalModuleFiles, lowerEvaluated?: (code: string) => string | undefined) {
  const tree = parse(source, { sourceType: "script", sourceFilename: filename, allowReturnOutsideFunction: true });
  const memoryException = applyNextMemoryException(tree, source, filename, files);
  const asyncSuper = lowerAsyncSuper(tree);
  let importName = "", requiresAsyncLowering = false;
  const edits = { rewritten: false };
  const evaluated: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  traverseModule(tree, {
    Program(path) { importName = path.scope.generateUidIdentifier("importLocal").name; },
    Function(path) { if (path.node.async === true) requiresAsyncLowering = true; },
    CallExpression(path) {
      const literal = path.node.arguments[0];
      if (lowerEvaluated !== undefined && path.node.arguments.length === 1 && t.isStringLiteral(literal) && t.isIdentifier(path.node.callee, { name: "eval" }) && path.scope.getBinding("eval") === undefined) {
        const lowered = lowerEvaluated(literal.value);
        if (lowered !== undefined && typeof literal.start === "number" && typeof literal.end === "number") {
          evaluated.push({ start: literal.start, end: literal.end, text: JSON.stringify(lowered) });
          path.node.arguments[0] = t.stringLiteral(lowered);
        }
      }
      if (t.isImport(path.node.callee)) {
        path.node.callee = t.identifier(importName);
        edits.rewritten = true;
      }
    },
    ImportExpression(path) {
      path.replaceWith(t.callExpression(t.identifier(importName), [path.node.source, ...(path.node.options == null ? [] : [path.node.options])]));
      edits.rewritten = true;
    },
  });
  if (edits.rewritten || memoryException || asyncSuper) return { importName, memoryException, requiresAsyncLowering, ...printModule(tree, source, filename) };
  // Only evaluated literals changed: they are replaced in place, each on its own line, so every other byte and every
  // line number of the script stays. Reprinting it would send it through the compiler, which renames bindings the
  // evaluated source reaches by name (webpack's `exports` parameter).
  let code = source;
  for (const edit of evaluated.sort((left, right) => right.start - left.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return { importName, memoryException, requiresAsyncLowering, code, map: undefined };
}
