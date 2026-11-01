import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { BuildFailure, finding } from "./findings.js";
import type { Finding, FindingCode, Location, Severity } from "./findings.js";

/** Maps a position in the bundled text (1-based line, 0-based column) to the file it came from. */
export type Locate = (line: number, column: number) => Location;
export const bundlePosition: Locate = (line, column) => ({ file: "adapter.mjs", line, column: column + 1 });

/** Free names that exist on a page but not in the dedicated worker an adapter runs in. */
const PAGE_ONLY: ReadonlySet<string> = new Set(["window", "document", "localStorage", "sessionStorage", "alert", "prompt", "confirm"]);

/** Every name the bundle declares somewhere, so a local called `document` is not mistaken for the global. */
function declaredNames(ast: t.File): ReadonlySet<string> {
  const names = new Set<string>();
  const declare = (pattern: t.Node | null | undefined): void => {
    if (pattern !== null && pattern !== undefined) for (const name of Object.keys(t.getBindingIdentifiers(pattern))) names.add(name);
  };
  t.traverseFast(ast, node => {
    if (t.isVariableDeclarator(node)) declare(node.id);
    else if (t.isFunction(node)) {
      for (const parameter of node.params) declare(parameter);
      if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) declare(node.id);
    } else if (t.isClass(node)) declare(node.id);
    else if (t.isCatchClause(node)) declare(node.param);
  });
  return names;
}

function isCallee(node: t.Identifier, parent: t.Node): boolean {
  return (t.isCallExpression(parent) || t.isNewExpression(parent)) && parent.callee === node;
}

interface Collected {
  readonly finding: Finding;
  count: number;
}

/**
 * Inspects the bundled adapter for what cannot work inside a pinned, self-contained module worker. Static and dynamic
 * imports are errors because the pinned bytes would no longer be everything that runs; page-only globals, `import.meta`
 * and `eval` are warnings because bundled third-party code often mentions them on paths a worker never takes.
 * Repeated warnings from one file are reported once with a count.
 */
export function lintAdapter(code: string, locate: Locate = bundlePosition): readonly Finding[] {
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: "module", createImportExpressions: true });
  } catch (error) {
    throw new BuildFailure([finding("error", "adapter-bundle", `the bundled adapter does not parse: ${error instanceof Error ? error.message : "unreadable"}`)]);
  }
  const declared = declaredNames(ast);
  const collected = new Map<string, Collected>();
  /** Code under node_modules often carries dynamic imports on branches a worker never takes; only the author's own is an error. */
  const severityFor = (node: t.Node): Severity => {
    const start = node.loc?.start;
    return start !== undefined && locate(start.line, start.column).file?.includes("node_modules/") === true ? "warning" : "error";
  };
  const report = (severity: Severity, code: FindingCode, message: string, node: t.Node): void => {
    const start = node.loc?.start;
    const located = finding(severity, code, message, start === undefined ? {} : locate(start.line, start.column));
    const key = severity === "error" ? String(collected.size) : `${code}|${located.file ?? ""}|${message}`;
    const existing = collected.get(key);
    if (existing === undefined) collected.set(key, { finding: located, count: 1 });
    else existing.count += 1;
  };
  t.traverse(ast, {
    enter(node, ancestors) {
      if (t.isImportDeclaration(node) || t.isExportAllDeclaration(node)) report("error", "adapter-import", `the adapter imports "${node.source.value}" at run time; an adapter must be one self-contained file`, node);
      else if (t.isExportNamedDeclaration(node) && node.source !== null && node.source !== undefined) report("error", "adapter-import", `the adapter re-exports from "${node.source.value}" at run time; an adapter must be one self-contained file`, node);
      else if (t.isImportExpression(node)) report(severityFor(node), "adapter-import", "dynamic import() would load code that is not part of the pinned adapter", node);
      else if (t.isMetaProperty(node) && node.meta.name === "import") report("warning", "adapter-meta", "import.meta refers to the blob the adapter is loaded from; ask host.artifacts.url(name) for an artifact's address", node);
      else if (t.isIdentifier(node) && !declared.has(node.name)) {
        const parent = ancestors.at(-1)?.node;
        if (parent === undefined || !t.isReferenced(node, parent, ancestors.at(-2)?.node) || t.isUnaryExpression(parent, { operator: "typeof" })) return;
        if (PAGE_ONLY.has(node.name)) report("warning", "adapter-global", `${node.name} does not exist in a worker; the adapter fails when this runs`, node);
        else if (node.name === "importScripts" && isCallee(node, parent)) report(severityFor(node), "adapter-import", "importScripts() would load code that is not part of the pinned adapter", node);
        else if ((node.name === "eval" || node.name === "Function") && isCallee(node, parent)) report("warning", "adapter-eval", `${node.name === "eval" ? "eval" : "new Function"} is blocked by a content security policy without 'unsafe-eval'`, node);
      }
    },
  });
  return [...collected.values()].map(entry => entry.count === 1 ? entry.finding : { ...entry.finding, message: `${entry.finding.message} (${String(entry.count)} places in this file)` });
}
