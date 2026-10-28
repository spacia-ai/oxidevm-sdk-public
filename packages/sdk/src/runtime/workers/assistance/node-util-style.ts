/*!
 * Portions adapted from Node.js v24.18.1 lib/util.js, lib/internal/streams/utils.js
 * and lib/internal/util/colors.js; modified for OxideVM's process owner.
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
type Style = { readonly open: string; readonly close: string; readonly keepClose: boolean };
type ProcessColors = { readonly stdout?: unknown; readonly env?: Readonly<Record<string, string | undefined>> };
function property(value: unknown, name: string): unknown {
  if (value === null || value === undefined) return undefined;
  const boxed: unknown = Object(value);
  if (typeof boxed !== "object" && typeof boxed !== "function" || boxed === null) throw new TypeError("Invalid style object");
  return Reflect.get(boxed, name);
}
function stream(value: unknown): boolean {
  const present = Boolean(value); if (!present) return false;
  const node = Boolean(property(value, "_readableState")) || Boolean(property(value, "_writableState"))
    || typeof property(value, "write") === "function" && typeof property(value, "on") === "function"
    || typeof property(value, "pipe") === "function" && typeof property(value, "on") === "function";
  return node || typeof property(value, "pipeThrough") === "function" && typeof property(value, "getReader") === "function" && typeof property(value, "cancel") === "function"
    || typeof property(value, "getWriter") === "function" && typeof property(value, "abort") === "function";
}
function colorize(value: unknown, env: ProcessColors["env"]): boolean {
  const force = env?.["FORCE_COLOR"];
  if (force !== undefined) return force === "" || force === "true" || force !== "false" && Math.min(Number.parseInt(force, 10), 3) > 0;
  const terminal = Boolean(property(value, "isTTY")); if (!terminal) return false;
  const depth = property(value, "getColorDepth");
  return typeof depth !== "function" || Number(Reflect.apply(depth, value, [])) > 2;
}
function replaceClose(text: string, style: Style): string {
  let result = "", start = 0, index = text.indexOf(style.close);
  while (index !== -1 && index + style.close.length < text.length) {
    result += text.slice(start, index) + (style.keepClose ? style.close + style.open : style.open);
    start = index + style.close.length; index = text.indexOf(style.close, start);
  }
  return result + text.slice(start);
}

/** Node's ANSI names come from the existing inspection dependency, never a second palette. */
export function createStyleText(getColors: () => unknown, process: ProcessColors, inspect: (value: unknown) => string) {
  let cache: Map<string, Style> | undefined;
  let names: string[] = [];
  const received = (value: unknown): string => {
    if (value === null || value === undefined) return `Received ${String(value)}`;
    if (typeof value !== "object" && typeof value !== "function") return `Received type ${typeof value} (${inspect(value)})`;
    const name = property(property(value, "constructor"), "name");
    return `Received an instance of ${typeof name === "string" ? name : "Object"}`;
  };
  const invalidType = (name: string, expected: string, value: unknown): TypeError => Object.assign(new TypeError(`The "${name}" argument must be ${expected}. ${received(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
  function styles(): Map<string, Style> {
    if (cache !== undefined) return cache;
    const colors = getColors();
    if (colors === null || typeof colors !== "object") throw new TypeError("Missing Node inspection palette");
    names = Object.getOwnPropertyNames(colors);
    cache = new Map<string, Style>(names.map((name): readonly [string, Style] => {
      const codes = property(colors, name);
      if (!Array.isArray(codes) || codes.length !== 2 || !codes.every((code: unknown) => typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255)) throw new TypeError("Invalid Node inspection color codes");
      const open: unknown = codes[0], close: unknown = codes[1];
      if (typeof open !== "number" || typeof close !== "number") throw new TypeError("Invalid Node inspection color pair");
      return [name, { open: `\u001b[${String(open)}m`, close: `\u001b[${String(close)}m`, keepClose: open === 1 || open === 2 }];
    }));
    return cache;
  }
  function lookup(key: string): Style | undefined {
    const known = styles().get(key); if (known !== undefined) return known;
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(key)) {
      const hex = key.length === 4 ? key.slice(1).split("").map(value => value + value).join("") : key.slice(1);
      const rgb = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
      return { open: `\u001b[38;2;${rgb.join(";")}m`, close: "\u001b[39m", keepClose: false };
    }
    return undefined;
  }
  function style(key: unknown): Style {
    if (typeof key === "string") { const found = lookup(key); if (found !== undefined) return found; }
    const detail = typeof key === "string" && key.startsWith("#") ? "must be a valid hex color (#RGB or #RRGGBB)" : `must be one of: ${names.map(name => `'${name}'`).join(", ")}`;
    throw Object.assign(new TypeError(`The argument 'format' ${detail}. Received ${inspect(key)}`), { code: "ERR_INVALID_ARG_VALUE" });
  }
  return function styleText(format: unknown, text: unknown, options?: unknown): string {
    const validate = property(options, "validateStream") ?? true;
    styles();
    const shouldValidate = Boolean(validate);
    // Node 24 checks the single-string fast path before validating the options object.
    if (!shouldValidate && typeof format === "string" && typeof text === "string") {
      if (format === "none") return text;
      const selected = lookup(format);
      if (selected !== undefined) return selected.open + replaceClose(text, selected) + selected.close;
    }
    if (typeof text !== "string") throw invalidType("text", "of type string", text);
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) throw invalidType("options", "of type object", options);
    if (typeof validate !== "boolean") throw invalidType("options.validateStream", "of type boolean", validate);
    let skip = false;
    if (validate) {
      const output = property(options, "stream") ?? process.stdout;
      if (!stream(output)) throw invalidType("stream", "an instance of ReadableStream, WritableStream, or Stream", output);
      skip = !colorize(output, process.env);
    }
    let open = "", close = "", processed = text;
    const keys: readonly unknown[] = Array.isArray(format) ? format : [format];
    for (const key of keys) {
      if (key === "none") continue;
      const selected = style(key);
      if (skip) continue;
      open += selected.open; close = selected.close + close; processed = replaceClose(processed, selected);
    }
    return skip ? text : open + processed + close;
  };
}
