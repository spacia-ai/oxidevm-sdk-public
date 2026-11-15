/**
 * The Node execution options the fast path implements (ADR 0026, 1.11), parsed as pinned Node
 * 24.18.1 parses them (`ParseNodeOptionsEnvVar`, `OptionsParser::Parse`). The engine admits a
 * launch only with these, in their canonical spelling (its native_addon/node_options.rs); any
 * other option, spelling or malformed value runs in Linux, where Node itself accepts or refuses
 * it. Bun launches carry the source-map flags only: Bun's options of the same names differ.
 */
export interface NodeExecutionOptions {
  /** The last of `--enable-source-maps` and `--no-enable-source-maps`. */
  readonly sourceMaps: boolean;
  readonly warnings: boolean;
  readonly deprecation: boolean;
  /** `--require` (`-r`): CommonJS modules preloaded from the working directory, in order. */
  readonly require: readonly string[];
  /** `--conditions` (`-C`): user conditions for package exports and imports. */
  readonly conditions: readonly string[];
}

export const DEFAULT_NODE_EXECUTION_OPTIONS: NodeExecutionOptions = Object.freeze({
  sourceMaps: false, warnings: true, deprecation: true, require: Object.freeze([]), conditions: Object.freeze([]),
});

/** Node's `ParseNodeOptionsEnvVar`: only spaces separate, double quotes group, and a backslash
 * escapes the next character inside quotes. Undefined for a value Node refuses. */
export function nodeOptionsTokens(value: string): string[] | undefined {
  const tokens: string[] = [];
  let quoted = false, current: string | undefined;
  for (let index = 0; index < value.length; index++) {
    let character = value.charAt(index);
    if (character === "\\" && quoted) {
      if (index + 1 === value.length) return undefined;
      character = value.charAt(++index);
    } else if (character === " " && !quoted) {
      if (current !== undefined) tokens.push(current);
      current = undefined;
      continue;
    } else if (character === "\"") {
      quoted = !quoted;
      continue;
    }
    current = (current ?? "") + character;
  }
  if (current !== undefined) tokens.push(current);
  return quoted ? undefined : tokens;
}

/** The options before the first argument that is not one (the script, or the end), applied over
 * `base`, and that argument's index; undefined when an option is not implemented as written. */
export function readNodeExecutionOptions(values: readonly string[], base: NodeExecutionOptions = DEFAULT_NODE_EXECUTION_OPTIONS,
  runtime: "node" | "bun" = "node"): { readonly options: NodeExecutionOptions; readonly end: number } | undefined {
  let { sourceMaps, warnings, deprecation } = base;
  const require = [...base.require], conditions = [...base.conditions];
  let index = 0;
  for (let argument = values[index]; argument !== undefined && argument.length > 1 && argument.startsWith("-"); argument = values[index]) {
    index++;
    if (argument === "--enable-source-maps" || argument === "--no-enable-source-maps") { sourceMaps = argument === "--enable-source-maps"; continue; }
    if (runtime === "bun") return undefined;
    if (argument === "--warnings" || argument === "--no-warnings") { warnings = argument === "--warnings"; continue; }
    if (argument === "--deprecation" || argument === "--no-deprecation") { deprecation = argument === "--deprecation"; continue; }
    let name = argument, value: string | undefined;
    if (argument === "--require" || argument === "-r" || argument === "--conditions" || argument === "-C") {
      value = values[index++];
      // Node takes the next argument, and refuses a missing one or one that starts with a dash.
      if (value === undefined || value.startsWith("-")) return undefined;
    } else {
      // `=` is allowed only on long names.
      const equals = argument.indexOf("=");
      if (equals === -1) return undefined;
      name = argument.slice(0, equals); value = argument.slice(equals + 1);
      if (name !== "--require" && name !== "--conditions") return undefined;
    }
    if (value === "") return undefined;
    (name === "--require" || name === "-r" ? require : conditions).push(value);
  }
  return { options: { sourceMaps, warnings, deprecation, require, conditions }, end: index };
}
