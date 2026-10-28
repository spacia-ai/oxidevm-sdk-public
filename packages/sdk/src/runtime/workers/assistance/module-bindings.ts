import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { parseModule, printModule, traverseModule } from "./module-syntax.ts";
import { lowerAsyncSuper } from "./async-super.js";

export interface ModuleImport {
  readonly source: string;
  readonly imported: string | null;
  readonly local: string;
}

export interface ModuleExport {
  readonly exported: string;
  readonly local: string;
}

export interface ModuleForward {
  readonly source: string;
  readonly imported: string | null;
  readonly exported: string;
}

export interface ModuleBindings {
  readonly imports: readonly ModuleImport[];
  readonly exports: readonly ModuleExport[];
  readonly forwards: readonly ModuleForward[];
  readonly stars: readonly string[];
  readonly dependencies: readonly { readonly source: string; readonly attributes: Readonly<Record<string, string>> }[];
  readonly runtimeName: string;
  readonly factoryName: string;
  readonly code: string;
  readonly map: string;
  readonly implementation: { readonly code: string; readonly map: string };
}

/** Suspend before the first statement so V8 retains native lexical initialization.
 * Export cells close over that scope; SWC only lowers the outer module wrapper.
 */
export function lowerModuleBindings(source: string, filename: string): ModuleBindings {
  const tree = parseModule(source, filename);
  lowerAsyncSuper(tree);
  const imports: ModuleImport[] = [];
  const exports: ModuleExport[] = [];
  const forwards: ModuleForward[] = [];
  const stars: string[] = [];
  const dependencies: { source: string; attributes: Readonly<Record<string, string>> }[] = [];
  let runtimeName = "";
  let factoryName = "";
  let defaultLocalName = "";
  traverseModule(tree, {
    Program(path) {
      runtimeName = path.scope.generateUidIdentifier("moduleRuntime").name;
      factoryName = path.scope.generateUidIdentifier("instantiateModule").name;
      defaultLocalName = path.scope.generateUidIdentifier("defaultExport").name;
      for (const statement of path.node.body) {
        if ((t.isImportDeclaration(statement) || t.isExportNamedDeclaration(statement) || t.isExportAllDeclaration(statement)) && statement.source != null) {
          dependencies.push({ source: statement.source.value, attributes: Object.fromEntries(
            (statement.attributes ?? []).map(attribute => [name(attribute.key), attribute.value.value]),
          ) });
        }
        if (t.isImportDeclaration(statement)) {
          for (const specifier of statement.specifiers) {
            const imported = t.isImportNamespaceSpecifier(specifier) ? null
              : t.isImportDefaultSpecifier(specifier) ? "default" : name(specifier.imported);
            imports.push({ source: statement.source.value, imported, local: specifier.local.name });
          }
        }
      }
      for (const imported of imports) {
        const binding = path.scope.getBinding(imported.local);
        if (binding === undefined) throw new SyntaxError("missing import binding");
        const value = () => t.memberExpression(
          runtimeCall(runtimeName, "importBinding", [t.stringLiteral(imported.local)]), t.identifier("value"),
        );
        // A call through an imported binding has undefined `this`, unlike a
        // member call. Namespace member calls still receive the namespace.
        for (const reference of binding.referencePaths) {
          if (reference.parentPath?.isUpdateExpression() === true || reference.parentPath?.isExportSpecifier() === true) continue;
          reference.replaceWith(t.sequenceExpression([t.numericLiteral(0), value()]));
        }
        for (const violation of binding.constantViolations) {
          violation.traverse({
            Identifier(target) {
              if (target.node.name === imported.local && target.scope.getBinding(imported.local) === binding &&
                  (t.isBinding(target.node, target.parent) || t.isReferenced(target.node, target.parent))) target.replaceWith(value());
            },
          });
        }
      }
    },
    CallExpression(path) {
      if (t.isImport(path.node.callee)) {
        const args = path.node.arguments;
        if (args.length < 1 || args.length > 2 || !args.every((argument): argument is t.Expression => t.isExpression(argument))) throw new SyntaxError("Invalid import expression");
        path.replaceWith(runtimeCall(runtimeName, "dynamicImport", args));
        return;
      }
      if (t.isIdentifier(path.node.callee, { name: "eval" }) && path.scope.getBinding("eval") === undefined && !literalLexicalRead(path)) {
        throw new SyntaxError("direct lexical eval is not supported by assisted modules");
      }
    },
    MetaProperty(path) {
      if (path.node.meta.name === "import" && path.node.property.name === "meta") {
        path.replaceWith(t.memberExpression(t.identifier(runtimeName), t.identifier("meta")));
      }
    },
    ReferencedIdentifier(path) {
      if (path.node.name !== "arguments" || path.scope.getBinding("arguments") !== undefined) return;
      let owner = path.getFunctionParent();
      while (owner?.isArrowFunctionExpression() === true) owner = owner.getFunctionParent();
      if (owner !== null) return;
      if (path.parentPath.isUnaryExpression({ operator: "typeof" })) {
        path.parentPath.replaceWith(runtimeCall(runtimeName, "globalTypeof", [t.stringLiteral("arguments")]));
      } else path.replaceWith(runtimeCall(runtimeName, "globalRead", [t.stringLiteral("arguments")]));
    },
  });
  const body: t.Statement[] = [];
  const initializers: t.Statement[] = [];
  for (const statement of tree.program.body) {
    if (t.isImportDeclaration(statement)) continue;
    if (t.isExportAllDeclaration(statement)) {
      stars.push(statement.source.value);
    } else if (t.isExportNamedDeclaration(statement)) {
      if (statement.declaration != null) {
        body.push(statement.declaration);
        for (const local of Object.keys(t.getBindingIdentifiers(statement.declaration))) {
          exports.push({ local, exported: local });
        }
      }
      for (const specifier of statement.specifiers) {
        if (t.isExportNamespaceSpecifier(specifier) && statement.source != null) {
          forwards.push({ source: statement.source.value, imported: null, exported: name(specifier.exported) });
        } else if (t.isExportSpecifier(specifier)) {
          if (statement.source != null) {
            forwards.push({ source: statement.source.value, imported: name(specifier.local), exported: name(specifier.exported) });
          } else {
            const imported = imports.find(value => value.local === name(specifier.local));
            if (imported === undefined) exports.push({ local: name(specifier.local), exported: name(specifier.exported) });
            else forwards.push({ source: imported.source, imported: imported.imported, exported: name(specifier.exported) });
          }
        } else throw new SyntaxError("unsupported module export form");
      }
    } else if (t.isExportDefaultDeclaration(statement)) {
      const declaration = statement.declaration;
      const local = defaultLocalName;
      if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) {
        if (declaration.id === null && t.isClassDeclaration(declaration)) {
          body.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(local), defaultExpression(
            t.classExpression(null, declaration.superClass, declaration.body, declaration.decorators),
          ))]));
          exports.push({ exported: "default", local });
        } else {
          if (declaration.id == null) {
            declaration.id = t.identifier(local);
            initializers.push(t.expressionStatement(runtimeCall(runtimeName, "defaultName", [t.identifier(local)])));
          }
          body.push(declaration);
          exports.push({ exported: "default", local: declaration.id.name });
        }
      } else if (t.isExpression(declaration)) {
        body.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(local), defaultExpression(declaration))]));
        exports.push({ exported: "default", local });
      } else throw new SyntaxError("unsupported default export declaration");
    } else body.push(statement);
  }
  // Imports only establish dependency edges; application reads use live cells.
  const dependencyImports = Array.from(new Set(dependencies.map(dependency => dependency.source)), dependency => t.importDeclaration([], t.stringLiteral(dependency)));
  const bindings = t.objectExpression(exports.map(binding => t.objectProperty(
    t.stringLiteral(binding.local), t.arrowFunctionExpression([], t.identifier(binding.local)),
  )));
  const generator = t.functionExpression(null, [], t.blockStatement([
    ...initializers, t.expressionStatement(t.yieldExpression(runtimeCall(runtimeName, "bind", [bindings]))), ...body,
  ], [t.directive(t.directiveLiteral("use strict"))]), true);
  const factory = t.functionDeclaration(t.identifier(factoryName), [t.identifier(runtimeName)],
    t.blockStatement([t.returnStatement(t.callExpression(generator, []))]));
  tree.program.body = [...dependencyImports, t.exportNamedDeclaration(factory)];
  tree.program.interpreter = null;
  lowerTopLevelAwait(tree, runtimeName);
  // SystemJS owns graph ordering, while the generator owns native lexical
  // semantics. Keep application syntax out of SWC's SystemJS pass: its
  // destructuring lowering changes observable iterator/default ordering.
  tree.program.body = [factory];
  const implementation = printModule(tree, source, filename);
  const implementationName = t.identifier(factoryName + "Implementation");
  tree.program.body = [...dependencyImports, t.exportNamedDeclaration(t.functionDeclaration(
    t.identifier(factoryName), [t.identifier(runtimeName), implementationName],
    t.blockStatement([t.returnStatement(t.callExpression(implementationName, [t.identifier(runtimeName)]))]),
  ))];
  const printed = printModule(tree, source, filename);
  return { imports, exports, forwards, stars, dependencies: Array.from(dependencies), runtimeName, factoryName, implementation, ...printed };
}

function defaultExpression(expression: t.Expression): t.MemberExpression {
  return t.memberExpression(t.objectExpression([t.objectProperty(t.identifier("default"), expression)]), t.identifier("default"));
}

function name(value: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(value) ? value.name : value.value;
}

function runtimeCall(runtimeName: string, method: string, args: t.Expression[]): t.CallExpression {
  return t.callExpression(t.memberExpression(t.identifier(runtimeName), t.identifier(method)), args);
}

/** Native eval can read an unchanged local binding; imported live cells need compiler routing. */
function literalLexicalRead(path: NodePath<t.CallExpression>): boolean {
  if (path.node.arguments.length !== 1) return false;
  const argument = path.node.arguments[0];
  const source = t.isStringLiteral(argument) ? argument.value
    : t.isTemplateLiteral(argument) && argument.expressions.length === 0 ? argument.quasis[0]?.value.cooked : undefined;
  if (typeof source !== "string" || !t.isValidIdentifier(source.trim())) return false;
  const binding = path.scope.getBinding(source.trim());
  return binding !== undefined && binding.kind !== "module";
}

function lowerTopLevelAwait(tree: t.File, runtimeName: string): void {
  traverseModule(tree, {
    AwaitExpression(path) {
      const owner = path.getFunctionParent();
      if (owner?.isFunctionExpression() === true && owner.node.generator && !owner.node.async) {
        path.replaceWith(t.yieldExpression(runtimeCall(runtimeName, "awaitValue", [path.node.argument])));
      }
    },
    ForOfStatement(path) {
      if (!path.node.await) return;
      const owner = path.getFunctionParent();
      if (owner?.isFunctionExpression() === true && owner.node.generator && !owner.node.async) {
        lowerAwaitLoop(path, runtimeName);
      }
    },
  });
}

function lowerAwaitLoop(path: NodePath<t.ForOfStatement>, runtimeName: string): void {
  const { left, right, body } = path.node;
  const iterator = path.scope.generateUidIdentifier("iterator");
  const step = path.scope.generateUidIdentifier("step");
  const completed = path.scope.generateUidIdentifier("completed");
  const failed = path.scope.generateUidIdentifier("failed");
  const error = path.scope.generateUidIdentifier("error");
  const value = path.scope.generateUidIdentifier("value");
  const next = t.yieldExpression(runtimeCall(runtimeName, "awaitValue", [t.callExpression(
    t.memberExpression(iterator, t.identifier("next")), [],
  )]));
  const assignment = t.isVariableDeclaration(left)
    ? t.variableDeclaration(left.kind, left.declarations.map(declaration =>
      t.variableDeclarator(declaration.id, value)))
    : t.expressionStatement(t.assignmentExpression("=", left, value));
  let loop: t.Statement = t.forStatement(null, null, null, t.blockStatement([
    t.expressionStatement(t.assignmentExpression("=", completed, t.booleanLiteral(true))),
    t.variableDeclaration("const", [t.variableDeclarator(step, next)]),
    t.ifStatement(t.memberExpression(step, t.identifier("done")), t.blockStatement([
      t.expressionStatement(t.assignmentExpression("=", completed, t.booleanLiteral(true))), t.breakStatement(),
    ])),
    t.variableDeclaration("const", [t.variableDeclarator(value, t.memberExpression(step, t.identifier("value")))]),
    t.expressionStatement(t.assignmentExpression("=", completed, t.booleanLiteral(false))),
    assignment, body,
  ]));
  const parent = path.parentPath;
  if (parent.isLabeledStatement()) loop = t.labeledStatement(parent.node.label, loop);
  const replacement = t.blockStatement([
    t.variableDeclaration("const", [t.variableDeclarator(iterator, runtimeCall(runtimeName, "asyncIterator", [right]))]),
    t.variableDeclaration("let", [t.variableDeclarator(completed, t.booleanLiteral(false)), t.variableDeclarator(failed, t.booleanLiteral(false))]),
    t.tryStatement(t.blockStatement([loop]), t.catchClause(error, t.blockStatement([
      t.expressionStatement(t.assignmentExpression("=", failed, t.booleanLiteral(true))), t.throwStatement(error),
    ])), t.blockStatement([
      t.ifStatement(t.unaryExpression("!", completed), t.tryStatement(t.blockStatement([
        t.expressionStatement(t.yieldExpression(runtimeCall(runtimeName, "awaitValue", [
          t.callExpression(t.memberExpression(iterator, t.identifier("close")), []),
        ]))),
      ]), t.catchClause(error, t.blockStatement([t.ifStatement(t.unaryExpression("!", failed), t.throwStatement(error))])))),
    ])),
  ]);
  if (parent.isLabeledStatement()) parent.replaceWith(replacement);
  else path.replaceWith(replacement);
}
