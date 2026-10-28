import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";
import type { ExecutableSources } from "./executable-sources.js";
import { printModule, traverseModule } from "./module-syntax.js";

const Evaluator = Function;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const unavailable = (): never => { throw new VMError("FEATURE_NOT_AVAILABLE", "vm contexts support only data scripts with plain data values"); };

/** This data-script subset creates no V8 context. It executes no functions or ambient browser operations. */
export function evaluateContextData(source: string, context: object, filename: string, sources: ExecutableSources): unknown {
  let nodes = 0, bytes = source.length * 2;
  const unsafe = new Set(forbidden);
  for (const prototype of [Object.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype]) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const property = Object.getOwnPropertyDescriptor(prototype, name);
      if (property?.get !== undefined || property?.set !== undefined || typeof property?.value === "function") unsafe.add(name);
    }
  }
  const seen = new WeakSet<object>();
  const charge = (size: number): void => { bytes += size; if (++nodes > 65536 || bytes > ASSISTANCE_LIMITS.pending) throw new VMError("QUOTA_EXCEEDED", "VM data-script budget exhausted"); };
  function data(value: unknown): void {
    charge(typeof value === "string" ? value.length * 2 : 8);
    if (value === null) return;
    if (typeof value === "object") {
      if (seen.has(value)) return; seen.add(value);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) unavailable();
      if (Object.getOwnPropertySymbols(value).length !== 0) unavailable();
      for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        charge(key.length * 2); if (forbidden.has(key) || !("value" in property)) unavailable();
        const entry: unknown = property.value; data(entry);
      }
    } else if (!["undefined", "boolean", "number", "string"].includes(typeof value)) unavailable();
  }
  data(context);
  if (Object.hasOwn(context, "globalThis") || Object.hasOwn(context, "arguments") || Object.hasOwn(context, "eval")) unavailable();
  const names = Object.keys(context).filter(name => t.isValidIdentifier(name));
  const bindings = new Set(["globalThis", "undefined", ...names]);
  const tree = parse(source, { sourceType: "script", sourceFilename: filename });
  traverseModule(tree, {
    enter(path) {
      charge(8);
      const node = path.node;
      if (!(t.isFile(node) || t.isProgram(node) || t.isExpressionStatement(node) || t.isEmptyStatement(node)
        || t.isAssignmentExpression(node, { operator: "=" }) || t.isMemberExpression(node) || t.isIdentifier(node)
        || t.isObjectExpression(node) || t.isObjectProperty(node) || t.isArrayExpression(node)
        || t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)
        || t.isLogicalExpression(node) || t.isUnaryExpression(node) || t.isDirective(node) || t.isDirectiveLiteral(node))) unavailable();
      if (t.isAssignmentExpression(node) && !t.isMemberExpression(node.left)) unavailable();
      if (t.isMemberExpression(node)) {
        const key = node.computed ? t.isStringLiteral(node.property) ? node.property.value : t.isNumericLiteral(node.property) ? String(node.property.value) : unavailable()
          : t.isIdentifier(node.property) ? node.property.name : unavailable();
        if (unsafe.has(key)) unavailable();
      }
      if (t.isObjectProperty(node) && (node.computed || (t.isIdentifier(node.key) && forbidden.has(node.key.name)) || (t.isStringLiteral(node.key) && forbidden.has(node.key.value)))) unavailable();
      if (t.isUnaryExpression(node) && (!["void", "!", "+", "-", "typeof"].includes(node.operator)
        || ((node.operator === "+" || node.operator === "-") && !t.isNumericLiteral(node.argument)))) unavailable();
      if (path.isReferencedIdentifier() && !bindings.has(path.node.name)) unavailable();
    },
  });
  const lastIndex = tree.program.body.findLastIndex(node => t.isExpressionStatement(node));
  const last = tree.program.body[lastIndex];
  if (last !== undefined && t.isExpressionStatement(last)) tree.program.body[lastIndex] = t.returnStatement(last.expression);
  else {
    const directive = tree.program.directives.at(-1);
    if (directive !== undefined) tree.program.body.push(t.returnStatement(t.stringLiteral(directive.value.value)));
  }
  const generated = printModule(tree, source, filename);
  const evaluate: unknown = Reflect.apply(Evaluator, undefined, ["globalThis", ...names, sources.emit(generated, filename, "generated-function")]);
  if (typeof evaluate !== "function") throw new TypeError("Invalid VM data evaluator");
  return Reflect.apply(evaluate, context, [context, ...names.map((name): unknown => Reflect.get(context, name))]);
}
