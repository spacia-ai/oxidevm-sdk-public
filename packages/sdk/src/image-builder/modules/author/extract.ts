import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { VMError } from "../../../runtime/errors.js";
import { decodeDeclaration } from "../../../wasm/manifest.js";
import type { ModuleDecl } from "../../../wasm/manifest-types.js";
import { BuildFailure, failure, finding } from "./findings.js";
import type { Location } from "./findings.js";

/** The longest module source the build reads; a module that needs more belongs in imported files. */
export const MAX_MODULE_SOURCE_BYTES = 1024 * 1024;

function at(file: string, node: t.Node): Location {
  const start = node.loc?.start;
  return start === undefined ? { file } : { file, line: start.line, column: start.column + 1 };
}

function describe(node: t.Node): string {
  if (t.isIdentifier(node)) return `a reference to ${node.name}`;
  if (t.isCallExpression(node) || t.isNewExpression(node)) return "a call";
  if (t.isSpreadElement(node)) return "a spread";
  if (t.isMemberExpression(node)) return "a property access";
  if (t.isFunction(node)) return "a function";
  return `a ${node.type}`;
}

function isConstAssertion(type: t.TSType): boolean {
  return t.isTSTypeReference(type) && t.isIdentifier(type.typeName, { name: "const" });
}

/**
 * Reads one manifest value without running anything: JSON-like literals, `as const` and `satisfies` wrappers, and
 * template strings without substitutions. A manifest is data, so nothing it names can be computed.
 */
function literal(node: t.Node, file: string, path: string): unknown {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isTemplateLiteral(node)) {
    const [only] = node.quasis;
    const cooked = only?.value.cooked;
    if (node.expressions.length === 0 && typeof cooked === "string") return cooked;
    return failure("manifest-literal", `${path} must be a plain string; a template with substitutions is computed`, at(file, node));
  }
  if (t.isUnaryExpression(node, { operator: "-" }) && t.isNumericLiteral(node.argument)) return -node.argument.value;
  if (t.isTSSatisfiesExpression(node)) return literal(node.expression, file, path);
  if (t.isTSAsExpression(node) && isConstAssertion(node.typeAnnotation)) return literal(node.expression, file, path);
  if (t.isArrayExpression(node)) return node.elements.map((element, index) => element === null ? failure("manifest-literal", `${path}[${String(index)}] is a hole`, at(file, node)) : literal(element, file, `${path}[${String(index)}]`));
  if (t.isObjectExpression(node)) return objectLiteral(node, file, path);
  return failure("manifest-literal", `${path} must be a literal value but is ${describe(node)}; a manifest is data, so it cannot compute or reference anything`, at(file, node));
}

function objectLiteral(node: t.ObjectExpression, file: string, path: string): Readonly<Record<string, unknown>> {
  const entries: [string, unknown][] = [];
  for (const property of node.properties) {
    if (!t.isObjectProperty(property) || property.computed) return failure("manifest-literal", `${path} may contain only plain \`key: value\` properties, not methods, spreads or computed keys`, at(file, property));
    const key = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : undefined;
    if (key === undefined || key === "__proto__") return failure("manifest-literal", `${path} has a property name that is not an identifier or string`, at(file, property));
    if (entries.some(([existing]) => existing === key)) return failure("manifest-literal", `${path}.${key} is declared twice`, at(file, property));
    entries.push([key, literal(property.value, file, `${path}.${key}`)]);
  }
  return Object.fromEntries(entries);
}

const SHAPE = "the module must `export default defineModule({ manifest: { ... }, adapter })`";

/** The `manifest` value of the one default export, which must be a direct `defineModule({ ... })` call. */
function manifestNode(ast: t.File, file: string): t.Node {
  const exported = ast.program.body.filter((statement): statement is t.ExportDefaultDeclaration => t.isExportDefaultDeclaration(statement));
  const [only, extra] = exported;
  if (only === undefined) return failure("manifest-literal", `${SHAPE}; there is no default export`, { file });
  if (extra !== undefined) return failure("manifest-literal", `${SHAPE}; there is more than one default export`, at(file, extra));
  const call = only.declaration;
  if (!t.isCallExpression(call) || !t.isIdentifier(call.callee, { name: "defineModule" }) || call.arguments.length !== 1) return failure("manifest-literal", `${SHAPE}; the default export is something else`, at(file, only));
  const [argument] = call.arguments;
  if (!t.isObjectExpression(argument)) return failure("manifest-literal", `${SHAPE}; defineModule takes one object literal`, at(file, call));
  const property = argument.properties.find((candidate): candidate is t.ObjectProperty => t.isObjectProperty(candidate) && !candidate.computed && (t.isIdentifier(candidate.key, { name: "manifest" }) || t.isStringLiteral(candidate.key, { value: "manifest" })));
  if (property === undefined) return failure("manifest-literal", `${SHAPE}; the object has no \`manifest\` property`, at(file, argument));
  return property.value;
}

function syntaxLocation(file: string, error: unknown): Location {
  const position: unknown = error instanceof SyntaxError ? Reflect.get(error, "loc") : undefined;
  const line: unknown = typeof position === "object" && position !== null ? Reflect.get(position, "line") : undefined;
  const column: unknown = typeof position === "object" && position !== null ? Reflect.get(position, "column") : undefined;
  return typeof line === "number" && typeof column === "number" ? { file, line, column: column + 1 } : { file };
}

/**
 * Reads the author's manifest out of `module.ts` and validates it as a declaration. The source is parsed, never
 * executed, so extraction cannot run author code; failures are located findings the author can act on.
 */
export function extractManifest(source: string, file: string): ModuleDecl {
  if (new TextEncoder().encode(source).byteLength > MAX_MODULE_SOURCE_BYTES) return failure("module-source", `${file} is larger than ${String(MAX_MODULE_SOURCE_BYTES)} bytes`, { file });
  let ast: t.File;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript"], sourceFilename: file });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unreadable";
    throw new BuildFailure([finding("error", "module-source", `${file} does not parse: ${reason}`, syntaxLocation(file, error))]);
  }
  const node = manifestNode(ast, file);
  const value = literal(node, file, "manifest");
  try {
    return decodeDeclaration(value);
  } catch (error) {
    if (error instanceof VMError) return failure("manifest-invalid", error.message, at(file, node));
    throw error;
  }
}
