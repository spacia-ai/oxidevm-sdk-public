// The scripts the worker puts into every proxied HTML page, ahead of the app's own: the WebSocket
// shim, then the location reporter, which tells the Playground where the page is.
import { isParentOrigin } from "./policy";

export const WEBSOCKET_SCRIPT = "/__oxidevm/websocket.js";
export const LOCATION_SCRIPT = "/__oxidevm/location.js";
const MAX_INJECTION_SCAN = 16 * 1024;

/** The page scripts for a session; the location reporter needs the parent it reports to, so a
 * page served before any parent is known gets the WebSocket shim alone. */
export function pageScripts(parentOrigin: string | null): Uint8Array {
  if (parentOrigin !== null && !isParentOrigin(parentOrigin)) throw new TypeError("page scripts need a bare parent origin");
  const websocket = `<script src="${WEBSOCKET_SCRIPT}"></script>`;
  const location = parentOrigin === null ? "" : `<script src="${LOCATION_SCRIPT}" data-oxidevm-parent="${parentOrigin}"></script>`;
  return new TextEncoder().encode(`${websocket}${location}`);
}

/** Streams HTML through, inserting the scripts after the first <head> tag (or before the first
 * body content when no head appears in the scan bound). */
export class HtmlInjector {
  readonly #script: Uint8Array;
  #buffer = new Uint8Array();
  #done = false;
  constructor(script: Uint8Array) { this.#script = script; }
  push(bytes: Uint8Array): Uint8Array {
    if (this.#done) return bytes;
    const merged = new Uint8Array(this.#buffer.byteLength + bytes.byteLength);
    merged.set(this.#buffer); merged.set(bytes, this.#buffer.byteLength);
    const text = new TextDecoder("latin1").decode(merged);
    const match = /<head(?:\s[^>]*)?>/i.exec(text);
    if (match !== null) {
      const at = match.index + match[0].length;
      this.#done = true; this.#buffer = new Uint8Array();
      return concat(merged.subarray(0, at), this.#script, merged.subarray(at));
    }
    if (merged.byteLength >= MAX_INJECTION_SCAN) {
      this.#done = true; this.#buffer = new Uint8Array();
      const doc = /<!doctype[^>]*>/i.exec(text);
      const at = doc === null ? 0 : doc.index + doc[0].length;
      return concat(merged.subarray(0, at), this.#script, merged.subarray(at));
    }
    this.#buffer = merged;
    return new Uint8Array();
  }
  finish(): Uint8Array {
    if (this.#done) return new Uint8Array();
    this.#done = true;
    const text = new TextDecoder("latin1").decode(this.#buffer);
    const doc = /<!doctype[^>]*>/i.exec(text);
    const at = doc === null ? 0 : doc.index + doc[0].length;
    return concat(this.#buffer.subarray(0, at), this.#script, this.#buffer.subarray(at));
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}
