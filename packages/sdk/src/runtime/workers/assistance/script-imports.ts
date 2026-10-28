import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { traverseModule, printModule } from "./module-syntax.ts";
import { applyNextMemoryException } from "./next-memory.ts";
import type { LocalModuleFiles } from "./module-files.ts";
import { lowerAsyncSuper } from "./async-super.js";

/** CommonJS import() must never invoke the browser's native module loader. */
export function lowerScriptImports(source: string, filename: string, files?: LocalModuleFiles) {
  const tree = parse(source, { sourceType: "script", sourceFilename: filename, allowReturnOutsideFunction: true });
  const memoryException = applyNextMemoryException(tree, source, filename, files);
  const asyncSuper = lowerAsyncSuper(tree);
  let importName = "", requiresAsyncLowering = false;
  const edits = { rewritten: false };
  traverseModule(tree, {
    Program(path) { importName = path.scope.generateUidIdentifier("importLocal").name; },
    Function(path) { if (path.node.async === true) requiresAsyncLowering = true; },
    CallExpression(path) {
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
  return { importName, memoryException, requiresAsyncLowering, ...(edits.rewritten || memoryException || asyncSuper
    ? printModule(tree, source, filename) : { code: source, map: undefined }) };
}
