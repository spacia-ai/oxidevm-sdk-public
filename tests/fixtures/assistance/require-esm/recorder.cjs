"use strict";
// Records require() of ES modules on the pinned Node.js 24.18.1 for the fast path's CommonJS loader
// (packages/sdk/src/runtime/workers/assistance/commonjs.ts); its output is require-esm.controls.json.
// The same `run` is replayed by require-esm.test.ts through the fast path's loader, so both sides run this file.
// Record with the runtime row of the engine's spec/acceleration/artifacts.tsv, through its own musl loader:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node \
//     -e 'require("./recorder.cjs").run(require).then(r => process.stdout.write(JSON.stringify(r, null, 2) + "\n"))'
// from this directory.

/** A value as JSON can carry it, with the facts a namespace or export object shows. */
function describe(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return { type: value === null ? "null" : typeof value, value: typeof value === "bigint" || typeof value === "symbol" ? String(value) : value };
  }
  const keys = Reflect.ownKeys(value).map(String);
  const entries = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") continue;
    let item;
    try { item = value[key]; } catch (error) { entries[key] = { threw: error && error.name }; continue; }
    entries[key] = item === null || (typeof item !== "object" && typeof item !== "function") ? item : { type: typeof item, name: typeof item === "function" ? item.name : undefined };
  }
  return {
    type: typeof value, keys, entries, tag: Object.prototype.toString.call(value),
    prototype: Object.getPrototypeOf(value) === null ? "null" : Object.getPrototypeOf(value) === Object.prototype ? "Object.prototype" : "other",
    extensible: Object.isExtensible(value), frozen: Object.isFrozen(value),
  };
}

function failure(error, root) {
  if (!(error instanceof Error)) return { thrown: typeof error };
  const clean = text => String(text).split(root).join("<root>");
  return { error: { class: error.constructor && error.constructor.name, code: error.code === undefined ? null : error.code, message: clean(error.message) } };
}

async function run(requireFrom) {
  const root = __dirname, rows = [];
  globalThis.__requireEsm = { ran: [] };
  const take = () => { const ran = globalThis.__requireEsm.ran; globalThis.__requireEsm.ran = []; return ran; };
  const attempt = (label, call) => {
    let row;
    try { row = { label, ...call() }; } catch (error) { row = { label, ...failure(error, root) }; }
    rows.push({ ...row, ran: take() });
  };

  attempt("named", () => ({ value: describe(requireFrom("./named.mjs")) }));
  attempt("named-again-same-object", () => ({ same: requireFrom("./named.mjs") === requireFrom("./named.mjs") }));
  attempt("module-exports-name", () => ({ value: describe(requireFrom("./module-exports.mjs")) }));
  attempt("default-only", () => ({ value: describe(requireFrom("./default-only.mjs")) }));
  attempt("no-default", () => ({ value: describe(requireFrom("./no-default.mjs")) }));
  attempt("own-esmodule", () => ({ value: describe(requireFrom("./own-esmodule.mjs")) }));
  attempt("type-module-js", () => ({ value: describe(requireFrom("./type-module/index.js")) }));
  attempt("imports-cjs", () => ({ value: describe(requireFrom("./imports-cjs.mjs")) }));
  attempt("tla-direct", () => ({ value: describe(requireFrom("./tla-direct.mjs")) }));
  attempt("tla-in-graph", () => ({ value: describe(requireFrom("./tla-parent.mjs")) }));
  attempt("tla-in-graph-again", () => ({ value: describe(requireFrom("./tla-parent.mjs")) }));
  attempt("cycle", () => ({ value: describe(requireFrom("./cycle-a.mjs")) }));
  attempt("cycle-from-cjs-parent", () => ({ value: describe(requireFrom("./cycle-outer.cjs")) }));
  attempt("tla-from-cjs-parent", () => ({ value: describe(requireFrom("./tla-outer.cjs")) }));
  attempt("esm-requires-esm", () => ({ value: describe(requireFrom("./esm-requires-esm.mjs")) }));
  attempt("throws", () => ({ value: describe(requireFrom("./throws.mjs")) }));
  attempt("throws-again", () => ({ value: describe(requireFrom("./throws.mjs")) }));
  attempt("module-sync-condition", () => ({ value: describe(requireFrom("require-esm-fixture/sync")) }));
  attempt("require-condition", () => ({ value: describe(requireFrom("require-esm-fixture/plain")) }));
  attempt("cache-entry", () => {
    const path = requireFrom.resolve("./named.mjs");
    const entry = requireFrom.cache[path];
    return { resolved: path.split(root).join("<root>"), cached: entry !== undefined, loaded: entry === undefined ? null : entry.loaded,
      exportsIsNamespace: entry === undefined ? null : entry.exports === requireFrom("./named.mjs") };
  });

  // Import first, then require: one evaluation, one namespace.
  const imported = await import("./once-import-first.mjs");
  rows.push({ label: "import-then-require", same: requireFrom("./once-import-first.mjs") === imported, ran: take() });
  // Require first, then import: one evaluation, one namespace.
  const required = requireFrom("./once-require-first.mjs");
  const later = await import("./once-require-first.mjs");
  rows.push({ label: "require-then-import", same: later === required, ran: take() });
  rows.push({ label: "feature", requireModule: process.features.require_module === true });
  return { rows };
}

module.exports = { run };
