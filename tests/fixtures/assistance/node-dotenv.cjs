"use strict";
// Records util.parseEnv on the pinned Node.js 24.18.1 for the port in
// packages/sdk/src/runtime/workers/assistance/node-dotenv.ts; its output is node-dotenv.controls.json.
// Run with the runtime row of the engine's spec/acceleration/artifacts.tsv, through its own musl loader:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-dotenv.cjs
const { parseEnv } = require("node:util");
const strings = [
  ["empty", ""], ["one", "A=1"], ["two", "A=1\nB=2"], ["crlf", "A=1\r\nB=2\r\n"], ["lone-cr", "A=1\rB=2"],
  ["spaced", "  A = 1  \n"], ["tabs", "\tA=1\t\n\tB=\t2\t"], ["blank-lines", "\n\n\nA=1\n\n\nB=2\n\n"], ["leading-trailing", "  \n  A=1  \n  "],
  ["export", "export A=1"], ["export-spaces", "export   A=1"], ["export-glued", "exportA=1"], ["export-empty-value", "export A=\nB=2"],
  ["export-only", "export =x"], ["export-twice", "export export A=1"], ["export-tab", "export\tA=1"],
  ["empty-value-eof", "A="], ["empty-value-line", "A=\nB=2"], ["space-value-line", "A= \nB=2"], ["tab-value-line", "A=\t\nB=2"],
  ["empty-key", "=1\nB=2"], ["empty-key-equals", "=a=b\nC=1"], ["empty-key-empty-value", "=\n"], ["spaces-key-empty-value", "   =\nA=1"],
  ["no-equals", "KEY"], ["no-equals-line", "KEY\nA=1"], ["comment", "# comment\nA=1"], ["indented-comment", "  # comment\nA=1"],
  ["indented-comment-equals", "  # a=b\nC=1"], ["comment-eof", "A=1\n# c"], ["inline-comment", "A=1 # comment"], ["glued-comment", "A=1#comment"],
  ["comment-next-line", "A=1 # c\nB=2"], ["hash-value", "A=#hash"], ["url-fragment", "URL=http://x/#frag\nB=2"],
  ["double", "A=\"quoted value\""], ["single", "A='single'"], ["backtick", "A=`back`"], ["double-escaped-newline", "A=\"multi\\nline\""],
  ["single-escaped-newline", "A='no\\nexpand'"], ["backtick-escaped-newline", "A=`no\\nexpand`"], ["double-real-newline", "A=\"real\nnewline\"\nB=2"],
  ["single-real-newline", "A='real\nnewline'\nB=2"], ["double-unterminated", "A=\"unterminated\nB=2"], ["single-unterminated-eof", "A='unterminated"],
  ["backtick-unterminated", "A=`x\nB=2"], ["double-trailing", "A=\"x\" trailing\nB=2"], ["double-escaped-quote", "A=\"x\\\"y\""],
  ["double-hash", "A=\"#notcomment\""], ["double-then-comment", "A=\"x\"#c\nB=2"], ["single-then-indented", "A='x'\n  B=2"],
  ["double-then-indented-comment", "A=\"x\"\n  # c=d\n"], ["double-spaces", "A=\"  spaced  \""], ["unquoted-spaces", "A=  spaced value  "],
  ["empty-double", "A=\"\""], ["empty-single", "A=''"], ["adjacent-quotes", "A=\"a\"\"b\""], ["double-only-newlines", "A=\"\\n\\n\""],
  ["double-backslash-n", "A=\"\\\\n\""], ["double-crlf-inside", "A=\"line1\r\nline2\""], ["mixed-quote", "A=\"x'"], ["quote-in-middle", "A=x\"y\""],
  ["equals-in-value", "A=b=c"], ["equals-spaced", "A = = b"], ["sorted", "B=2\nA=1\nC=3"], ["duplicate", "A=1\nA=2"],
  ["duplicate-order", "B=1\nA=2\nB=3"], ["integer-keys", "10=a\n2=b\nb=c\na=d\n-1=e\n01=f"], ["proto", "__proto__=x\nconstructor=y\ntoString=z"],
  ["unicode-order", "ü=1\nz=2\n😀=3\n=4\nZ=5"], ["lone-surrogate", "A=\ud800\nB=\udc00x"], ["lone-surrogate-key", "\ud800=1"],
  ["nul", "A=x\u0000y\n\u0000=z"], ["form-feed", "A=\fx\f\nB=\vy"], ["only-spaces", "   \t \n "], ["only-comment", "#"],
  ["equals-only", "="], ["newline-equals", "\n=\n"], ["key-spaces-inside", "MY KEY=1"], ["unicode-value", "A=zażółć 😀"],
  ["windows-final", "A=\"x\"\r\n"], ["value-then-eof-spaces", "A=1   "], ["many", Array.from({ length: 40 }, (_, i) => `K${String(39 - i).padStart(2, "0")}=v${i}`).join("\n")],
];
const others = {
  "no-argument": () => parseEnv(), undefined: () => parseEnv(undefined), null: () => parseEnv(null), number: () => parseEnv(1),
  "negative-zero": () => parseEnv(-0), nan: () => parseEnv(NaN), bigint: () => parseEnv(1n), boolean: () => parseEnv(true),
  symbol: () => parseEnv(Symbol("x")), object: () => parseEnv({}), array: () => parseEnv([]), "string-object": () => parseEnv(new String("A=1")),
  "null-prototype": () => parseEnv(Object.create(null)), function: () => parseEnv(function named() {}), buffer: () => parseEnv(Buffer.from("A=1")),
};
const entries = value => ({ entries: Object.entries(value), keys: Reflect.ownKeys(value).length, plain: Object.getPrototypeOf(value) === Object.prototype });
const rows = strings.map(([label, input]) => ({ label, input, ...entries(parseEnv(input)) }));
for (const [label, run] of Object.entries(others)) {
  try { rows.push({ label, value: run() }); }
  catch (error) { rows.push({ label, error: { name: error.name, code: error.code, message: error.message } }); }
}
process.stdout.write(JSON.stringify({ name: parseEnv.name, length: parseEnv.length, prototype: typeof parseEnv.prototype, rows }));
