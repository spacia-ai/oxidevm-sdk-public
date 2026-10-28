import { Buffer } from "buffer";

type Encoding = "utf8" | "utf16le" | "latin1" | "base64" | "hex" | "ascii";

function normalize(encoding: unknown): Encoding {
  if (encoding !== undefined && typeof encoding !== "string") throw Object.assign(new TypeError("Unknown encoding: the encoding must be a string"), { code: "ERR_UNKNOWN_ENCODING" });
  const name = encoding === undefined ? "utf8" : encoding.toLowerCase();
  switch (name) {
    case "utf8": case "utf-8": return "utf8";
    case "utf16le": case "utf-16le": case "ucs2": case "ucs-2": return "utf16le";
    case "latin1": case "binary": return "latin1";
    case "base64": return "base64";
    case "hex": return "hex";
    case "ascii": return "ascii";
    default: throw Object.assign(new TypeError(`Unknown encoding: ${name}`), { code: "ERR_UNKNOWN_ENCODING" });
  }
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw Object.assign(new TypeError("The \"buf\" argument must be an instance of Buffer, TypedArray, or DataView"), { code: "ERR_INVALID_ARG_TYPE" });
}

/** Node's `string_decoder`: decodes byte chunks into strings while carrying
 * incomplete multi-byte sequences (UTF-8, UTF-16LE) and base64 groups
 * across writes; `end` flushes an incomplete sequence as U+FFFD. */
export class StringDecoder {
  readonly encoding: Encoding;
  readonly #decoder: TextDecoder | undefined;
  #carry = new Uint8Array(0);
  constructor(encoding?: unknown) {
    this.encoding = normalize(encoding);
    this.#decoder = this.encoding === "utf8" || this.encoding === "utf16le"
      ? new TextDecoder(this.encoding === "utf8" ? "utf-8" : "utf-16le", { fatal: false, ignoreBOM: true }) : undefined;
  }
  write(value: unknown): string {
    if (typeof value === "string") return value;
    const bytes = bytesOf(value);
    if (this.#decoder !== undefined) return this.#decoder.decode(bytes, { stream: true });
    switch (this.encoding) {
      case "utf8": case "utf16le": return "";
      case "latin1": return String.fromCharCode(...bytes);
      case "ascii": return String.fromCharCode(...bytes.map(byte => byte & 0x7f));
      case "hex": return Buffer.from(bytes).toString("hex");
      case "base64": {
        const joined = new Uint8Array(this.#carry.length + bytes.length);
        joined.set(this.#carry); joined.set(bytes, this.#carry.length);
        const complete = joined.length - (joined.length % 3);
        this.#carry = joined.slice(complete);
        return Buffer.from(joined.subarray(0, complete)).toString("base64");
      }
    }
  }
  end(value?: unknown): string {
    let text = value === undefined ? "" : this.write(value);
    if (this.#decoder !== undefined) text += this.#decoder.decode(new Uint8Array(0), { stream: false });
    else if (this.encoding === "base64" && this.#carry.length > 0) { text += Buffer.from(this.#carry).toString("base64"); this.#carry = new Uint8Array(0); }
    return text;
  }
}

export const nodeStringDecoder = Object.freeze({ StringDecoder });
