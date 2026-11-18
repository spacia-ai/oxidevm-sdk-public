/*!
 * The message lists are those of Node.js v24.18.1 src/node_contextify.cc (esm_syntax_error_messages,
 * throws_only_in_cjs_error_messages) and the warning of lib/internal/modules/esm/get_format.js.
 * Copyright Node.js contributors. All rights reserved. Used under the MIT license of Node.js:
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { parseModule } from "./module-syntax.ts";

/** The realm's own Function, taken when the worker loads this module and before generated-function
 * isolation replaces the global: detection only parses the source, it never runs it. */
const IntrinsicFunction = Function;

/** Errors V8 gives only to module syntax in a CommonJS body. */
const ESM_SYNTAX = new Set(["Cannot use import statement outside a module", "Unexpected token 'export'", "Cannot use 'import.meta' outside a module"]);
/** Errors that only the CommonJS wrapper causes: Node then compiles the source as a module, and uses it as one when that succeeds. */
const ONLY_IN_COMMONJS = new Set([
  "Identifier 'module' has already been declared", "Identifier 'exports' has already been declared", "Identifier 'require' has already been declared",
  "Identifier '__filename' has already been declared", "Identifier '__dirname' has already been declared",
  "await is only valid in async functions and the top level bodies of modules",
  // A top-level `for await` (recorded: pinned Node runs such a file as a module).
  "Unexpected reserved word",
]);

/** Node 24's syntax detection for a `.js` or extensionless file whose package sets no `"type"`: the file is an
 * ES module when its CommonJS compile fails on module syntax. */
export function hasModuleSyntax(source: string, filename: string): boolean {
  // A hashbang is legal only where the file starts, not inside the wrapper's body.
  const body = source.startsWith("#!") ? `//${source.slice(2)}` : source;
  try {
    Reflect.construct(IntrinsicFunction, ["exports", "require", "module", "__filename", "__dirname", body]);
    return false;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (ESM_SYNTAX.has(error.message)) return true;
    if (!ONLY_IN_COMMONJS.has(error.message)) return false;
    try { parseModule(source, filename); return true; } catch { return false; }
  }
}

/** The warning Node prints once per `package.json` when it reparses an imported file outside `node_modules`. */
export function typelessPackageWarning(fileURL: string, packageJSON: string): string {
  return `Module type of ${fileURL} is not specified and it doesn't parse as CommonJS.\n`
    + "Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\n"
    + `To eliminate this warning, add "type": "module" to ${packageJSON}.`;
}
