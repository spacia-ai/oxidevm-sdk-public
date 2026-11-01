import { invalid } from "./decode-support.js";

export interface LicenseClassification {
  /** Every license identifier the expression names, in order of appearance. */
  readonly ids: readonly string[];
  /** True when every way of satisfying the expression imposes a copyleft license. */
  readonly copyleft: boolean;
}

const COPYLEFT = /^(?:A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CPAL|RPL|SSPL|CC-BY-SA)(?:-|$)/u;
const IDENTIFIER = /^(?:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*\+?)$/u;
const REJECTED = new Set(["NOASSERTION", "NONE"]);

type Expression =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "and" | "or"; readonly left: Expression; readonly right: Expression };

/**
 * Validates an SPDX license expression and classifies it. A `WITH` exception keeps the copyleft
 * class of its base license, `AND` is copyleft when either side is, and `OR` only when both are,
 * because the licensee may choose the permissive branch.
 */
export function classifyLicense(spdx: string, label = "license.spdx"): LicenseClassification {
  const tokens = spdx.match(/\(|\)|[^\s()]+/gu) ?? [];
  const ids: string[] = [];
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const next = (): string | undefined => tokens[position++];
  function term(): Expression {
    const token = next();
    if (token === undefined) return invalid(label, "ends unexpectedly");
    if (token === "(") {
      const inner = orExpression();
      if (next() !== ")") invalid(label, "has an unclosed parenthesis");
      return inner;
    }
    if (token === ")" || token === "AND" || token === "OR" || token === "WITH" || REJECTED.has(token) || !IDENTIFIER.test(token)) {
      return invalid(label, `has an invalid token ${JSON.stringify(token)}`);
    }
    ids.push(token);
    if (peek() === "WITH") {
      next();
      const exception = next();
      if (exception === undefined || !IDENTIFIER.test(exception)) invalid(label, "names no exception after WITH");
    }
    return { kind: "id", id: token };
  }
  function andExpression(): Expression {
    let left = term();
    while (peek() === "AND") { next(); left = { kind: "and", left, right: term() }; }
    return left;
  }
  function orExpression(): Expression {
    let left = andExpression();
    while (peek() === "OR") { next(); left = { kind: "or", left, right: andExpression() }; }
    return left;
  }
  const tree = orExpression();
  if (position !== tokens.length) invalid(label, "has trailing tokens");
  return { ids, copyleft: isCopyleft(tree) };
}

function isCopyleft(expression: Expression): boolean {
  switch (expression.kind) {
    case "id": return COPYLEFT.test(expression.id);
    case "and": return isCopyleft(expression.left) || isCopyleft(expression.right);
    case "or": return isCopyleft(expression.left) && isCopyleft(expression.right);
  }
}
