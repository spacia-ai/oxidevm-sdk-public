import { type AssistanceCompiler, transformSource } from "./compiler.ts";

const LABEL = /^\/\/# (?:sourceURL|sourceMappingURL)=.*$/u;
const INLINE_MAP = /^\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)$/u;

function decodeBase64(text: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(text), character => character.charCodeAt(0)));
}
function encodeBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A source a loaded module passes to a direct `eval` as a literal (webpack's development output evaluates every module
 * that way) never crosses the loader, so its `await` would stay native and lose the process's async context: Next.js
 * then fails with "Expected workStore to be initialized". This lowers its async functions exactly as a loaded module's
 * are lowered. The trailing `//# sourceURL` and `//# sourceMappingURL` labels are kept, and an inline source map is
 * carried through the lowering. Returns undefined when the source has no async function and stays as it is. */
export function lowerEvaluatedSource(compiler: AssistanceCompiler, source: string, filename: string): string | undefined {
  if (!/\basync\b/u.test(source)) return undefined;
  const lines = source.split("\n"), labels: string[] = [];
  while (lines.length !== 0) {
    const last = lines.at(-1) ?? "";
    if (last !== "" && !LABEL.test(last)) break;
    lines.pop(); if (last !== "") labels.unshift(last);
  }
  // Webpack puts its first label on the last line of code.
  const tail = lines.at(-1) ?? "", attached = tail.lastIndexOf("//# sourceURL=");
  if (attached >= 0) { lines[lines.length - 1] = tail.slice(0, attached); labels.unshift(tail.slice(attached)); }
  let inputMap: string | undefined;
  for (const label of labels) {
    const encoded = INLINE_MAP.exec(label)?.[1];
    if (encoded !== undefined) { try { inputMap = decodeBase64(encoded); } catch { inputMap = undefined; } }
  }
  const lowered = transformSource(compiler, lines.join("\n"), "commonjs", filename, inputMap);
  const kept = labels.map(label => inputMap !== undefined && INLINE_MAP.test(label) ? `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${encodeBase64(lowered.map)}` : label);
  return [lowered.code, ...kept, ""].join("\n");
}
