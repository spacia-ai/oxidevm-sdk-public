/*!
 * Portions adapted from Node.js v24.18.1 src/node_dotenv.cc (Dotenv::ParseContent, Dotenv::ToObject)
 * and lib/util.js (parseEnv).
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

const encoder = new TextEncoder();

/** Node's `trim_spaces`: only space, tab and newline. */
function trimSpaces(input: string): string {
  let start = 0, end = input.length;
  while (start < end && " \t\n".includes(input.charAt(start))) start++;
  while (end > start && " \t\n".includes(input.charAt(end - 1))) end--;
  return input.slice(start, end);
}

/** The next newline at or after `from`, or the end of `content`. */
function afterLine(content: string, from: number): string {
  const newline = content.indexOf("\n", from);
  return newline === -1 ? "" : content.slice(newline + 1);
}

/** Node's `std::map` order: UTF-8 bytes, which is code point order. */
function byteOrder(left: string, right: string): number {
  const a = encoder.encode(left), b = encoder.encode(right);
  for (let index = 0; index < a.length && index < b.length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * A literal port of `Dotenv::ParseContent` on pinned Node 24.18.1, quirks kept: a key with an
 * empty value is stored before `export ` is removed, a value line after an empty key is parsed
 * as the next line, and only double quotes expand `\n`. Node reads the string as UTF-8, so lone
 * surrogates become U+FFFD; every cut is at an ASCII byte, so cutting UTF-16 here is the same.
 */
export function parseDotenv(input: string): Record<string, string> {
  const store = new Map<string, string>();
  let content = trimSpaces(input.toWellFormed().replaceAll("\r", ""));
  while (content.length > 0) {
    const first = content.charAt(0);
    if (first === "\n" || first === "#") { content = afterLine(content, 0); continue; }
    const equals = content.indexOf("="), newline = content.indexOf("\n");
    if (equals === -1 || (newline !== -1 && newline < equals)) {
      if (newline === -1) break;
      content = trimSpaces(content.slice(newline + 1));
      continue;
    }
    let key = trimSpaces(content.slice(0, equals));
    content = content.slice(equals + 1);
    if (content.length === 0 || content.charAt(0) === "\n") { store.set(key, ""); continue; }
    content = trimSpaces(content);
    if (key.length === 0) continue;
    if (key.startsWith("export ")) key = trimSpaces(key.slice(7));
    if (content.length === 0) { store.set(key, ""); break; }
    const quote = content.charAt(0);
    if (quote === "\"") {
      const closing = content.indexOf(quote, 1);
      if (closing !== -1) {
        store.set(key, content.slice(1, closing).replaceAll("\\n", "\n"));
        content = afterLine(content, closing + 1);
        continue;
      }
    }
    if (quote === "'" || quote === "\"" || quote === "`") {
      const closing = content.indexOf(quote, 1);
      if (closing !== -1) {
        store.set(key, content.slice(1, closing));
        content = afterLine(content, closing + 1);
        continue;
      }
      const end = content.indexOf("\n");
      if (end === -1) { store.set(key, content); break; }
      store.set(key, content.slice(0, end));
      content = content.slice(end + 1);
    } else {
      const end = content.indexOf("\n"), line = end === -1 ? content : content.slice(0, end), hash = line.indexOf("#");
      store.set(key, trimSpaces(hash === -1 ? line : line.slice(0, hash)));
      content = end === -1 ? "" : content.slice(end + 1);
    }
    content = trimSpaces(content);
  }
  // `Dotenv::ToObject` sets each entry on a new ordinary object: `__proto__` reaches the
  // prototype setter, which ignores a string, and index-like keys come first, as in V8.
  const result: Record<string, string> = {};
  for (const key of Array.from(store.keys()).sort(byteOrder)) result[key] = store.get(key) ?? "";
  return result;
}
