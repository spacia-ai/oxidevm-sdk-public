export function licenseAllowed(
  expression: string,
  licenses: ReadonlySet<string>,
): boolean {
  return selectedLicense(expression, licenses) !== undefined;
}

/** Preserve the selected terms in notices instead of reducing an SPDX expression to a boolean. */
export function selectedLicense(expression: string, licenses: ReadonlySet<string>): string | undefined {
  const tokens = expression.match(/\(|\)|AND|OR|WITH|[A-Za-z0-9.+-]+/gu) ?? [];
  if (tokens.join("") !== expression.replace(/\s+/gu, "")) return undefined;

  let position = 0;
  try {
    const result = parseOr();
    return position === tokens.length ? result : undefined;
  } catch {
    return undefined;
  }

  function parseOr(): string | undefined {
    let value = parseAnd();
    while (tokens[position] === "OR") {
      position += 1;
      const right = parseAnd();
      value = value ?? right;
    }
    return value;
  }

  function parseAnd(): string | undefined {
    let value = parsePrimary();
    while (tokens[position] === "AND") {
      position += 1;
      const right = parsePrimary();
      value = value === undefined || right === undefined ? undefined : `(${value} AND ${right})`;
    }
    return value;
  }

  function parsePrimary(): string | undefined {
    if (tokens[position] === "(") {
      position += 1;
      const value = parseOr();
      if (tokens[position] !== ")") throw new Error("missing ')'");
      position += 1;
      return value;
    }

    const license = tokens[position];
    if (
      license === undefined ||
      license === ")" ||
      license === "AND" ||
      license === "OR" ||
      license === "WITH"
    ) {
      throw new Error("expected license");
    }
    position += 1;
    if (tokens[position] !== "WITH") return licenses.has(license) ? license : undefined;

    position += 1;
    const exception = tokens[position];
    if (exception === undefined) throw new Error("expected exception");
    position += 1;
    const combined = `${license} WITH ${exception}`;
    return licenses.has(combined) ? combined : undefined;
  }
}
