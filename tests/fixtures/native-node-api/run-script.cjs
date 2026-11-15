// napi_run_script observations (ADR 0026, 2.12), through script-evaluation-proof.c's inspect:
// each row is the status and the completion value, or the exception's name. No row reads a
// binding another row declares.
module.exports = function exercise(inspect) {
  const rows = [];
  const describe = value => value === undefined ? "undefined" : value instanceof Error ? `error:${value.name}` : typeof value === "function" ? `function:${value.name}` : typeof value === "object" && value !== null ? `object:${JSON.stringify(value)}` : `${typeof value}:${String(value)}`;
  const run = (name, source) => { const [status, value] = inspect(source); rows.push([name, status, describe(value)]); };
  run("completion", "40 + 2");
  run("empty", "");
  run("comment-only", "// nothing\n/* nothing */");
  run("this-global", "this === globalThis");
  run("strict-this-global", "'use strict'; this === globalThis");
  run("directive-only", "'use strict'");
  run("strict-function-this", "'use strict'; (function () { return this; })() === undefined");
  run("sloppy-function-this", "(function () { return this; })() === globalThis");
  run("completion/if-false", "1; if (false) 2;");
  run("completion/if-true", "1; if (true) 2;");
  run("completion/empty-block", "1; {}");
  run("completion/empty-statement", "1; ;");
  run("completion/do-break", "1; do { 2; break; } while (false)");
  run("completion/while-none", "1; while (false) 2;");
  run("completion/try-finally", "1; try { 2 } finally { 3 }");
  run("completion/catch", "1; try { throw 0 } catch (error) { 4 }");
  run("completion/switch", "switch (1) { case 1: 5; }");
  run("completion/label", "l: { 6; break l; }");
  run("completion/for-of", "for (const item of [7, 8]) item;");
  run("function-expression", "(function named() { return 9; })()");
  run("arrow-local-var", "(() => { var inner = 10; return inner; })()");
  run("block-lexical", "{ let scoped = 11; scoped }");
  run("global-assignment", "globalThis.__oxidevmRunScriptAssigned = 12; __oxidevmRunScriptAssigned");
  run("dynamic-function", "Function('return 13')()");
  run("direct-eval-var", "eval('var __oxidevmRunScriptDirect = 14'); [__oxidevmRunScriptDirect, Object.getOwnPropertyDescriptor(globalThis, '__oxidevmRunScriptDirect').configurable]");
  run("throws", "throw new RangeError('x')");
  run("syntax-error", "1 +");
  run("reference-error", "__oxidevmRunScriptMissing");
  run("strict-delete", "'use strict'; delete Object.prototype");
  const [status, value] = inspect(42); rows.push(["non-string", status, describe(value)]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "eval");
  let reads = 0;
  Object.defineProperty(globalThis, "eval", { configurable: true, get() { reads++; throw new Error("application eval getter"); } });
  try { run("replaced-eval", "6 * 7"); }
  finally { if (previous === undefined) Reflect.deleteProperty(globalThis, "eval"); else Object.defineProperty(globalThis, "eval", previous); }
  rows.push(["application-eval-reads", 0, `number:${reads}`]);
  run("declares/var", "var __oxidevmRunScriptVar = 15; __oxidevmRunScriptVar");
  run("declares/function", "function __oxidevmRunScriptFunction() { return 16; } __oxidevmRunScriptFunction()");
  run("declares/let", "let __oxidevmRunScriptLet = 17; __oxidevmRunScriptLet");
  run("declares/const", "const __oxidevmRunScriptConst = 18; __oxidevmRunScriptConst");
  run("declares/class", "class __oxidevmRunScriptClass {} typeof __oxidevmRunScriptClass");
  run("declares/nested-var", "if (true) { var __oxidevmRunScriptNested = 19; } __oxidevmRunScriptNested");
  run("declares/block-function", "{ function __oxidevmRunScriptBlock() { return 20; } } __oxidevmRunScriptBlock()");
  run("declares/for-var", "for (var __oxidevmRunScriptLoop = 0; __oxidevmRunScriptLoop < 2; __oxidevmRunScriptLoop++); __oxidevmRunScriptLoop");
  run("declares/strict-var", "'use strict'; var __oxidevmRunScriptStrict = 21; __oxidevmRunScriptStrict");
  return JSON.stringify(rows);
};
