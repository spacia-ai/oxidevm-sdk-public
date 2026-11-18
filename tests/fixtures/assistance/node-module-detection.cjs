"use strict";
// Records Node.js 24.18.1's syntax detection for a .js file whose package.json has no "type", for
// packages/sdk/src/runtime/workers/assistance/module-detection.ts; its output is module-detection.controls.json.
// Run with the runtime row of the engine's spec/acceleration/artifacts.tsv, through its own musl loader:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-module-detection.cjs
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { registerHooks } = require("node:module");
const cases = [
  ["plain", "exports.value = 1;"],
  ["import-declaration", "import 'node:os';"],
  ["export-declaration", "export const value = 1;"],
  ["export-list", "const value = 1; export { value };"],
  ["import-meta", "const url = import.meta.url;"],
  ["top-level-await", "await Promise.resolve();"],
  ["await-in-for-of", "for await (const x of []) {}"],
  ["redeclared-require", "const require = 1;"],
  ["redeclared-module", "let module = 2;"],
  ["redeclared-exports", "class exports {}"],
  ["redeclared-filename", "const __filename = 'x';"],
  ["redeclared-dirname", "const __dirname = 'x';"],
  ["redeclared-require-and-return", "const require = 1; return;"],
  ["await-identifier", "var await = 1; exports.value = await;"],
  ["dynamic-import", "exports.load = () => import('node:os');"],
  ["import-in-string", "exports.text = \"import x from 'y'\";"],
  ["import-in-comment", "// import x from 'y'\nexports.value = 1;"],
  ["top-level-return", "return; exports.value = 1;"],
  ["return-then-export", "return; export {};"],
  ["hashbang-import", "#!/usr/bin/env node\nimport 'node:os';"],
  ["hashbang-plain", "#!/usr/bin/env node\nexports.value = 1;"],
  ["unrelated-syntax-error", "exports.value = ;"],
  ["broken-module-syntax", "import { from 'node:os';"],
  ["await-in-function", "function f() { await 1; }"],
  ["await-and-require-call", "const os = require('node:os'); await 0;"],
  ["strict-octal-and-export", "var n = 010; export {};"],
  ["with-statement-and-await", "with ({}) {} await 0;"],
  ["arguments-and-export", "exports.n = arguments.length; export {};"],
  ["html-comment-and-export", "<!-- comment\nexport {};"],
];
const root = mkdtempSync(join(tmpdir(), "detect-"));
writeFileSync(join(root, "package.json"), "{}\n");
const formats = new Map();
registerHooks({ load(url, context, next) { const result = next(url, context); formats.set(url, result.format); return result; } });
(async () => {
  const rows = [];
  for (const [name, source] of cases) {
    const file = join(root, `${name}.js`), url = pathToFileURL(file).href;
    writeFileSync(file, source);
    let outcome = "loaded";
    try { await import(url); } catch (error) { outcome = `${error.name}`; }
    rows.push({ name, source, format: formats.get(url) ?? null, outcome });
  }
  rmSync(root, { recursive: true });
  process.stdout.write(`${JSON.stringify({ rows }, null, 2)}\n`);
})();
