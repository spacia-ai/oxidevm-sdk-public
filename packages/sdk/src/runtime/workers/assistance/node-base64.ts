import { VMError } from "../../errors.js";

const NativeDOMException = DOMException, NativeTypeError = TypeError, nativeString = String;

/** Browser codecs supply the bytes; the selected guest runtime owns coercion and errors. */
export function createNodeBase64(globals: object, runtime: "node" | "bun"): {
  readonly atob: (input?: unknown) => unknown;
  readonly btoa: (input?: unknown) => unknown;
} {
  function operation(name: "atob" | "btoa") {
    const codec: unknown = Reflect.get(globals, name);
    if (typeof codec !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", `buffer is unavailable: the platform lacks ${name}`, { builtin: "buffer", missing: name });
    return (input: unknown, supplied: boolean): unknown => {
      if (!supplied) {
        if (runtime === "bun") throw new NativeTypeError(`${name} requires 1 argument (a string)`);
        throw Object.assign(new NativeTypeError('The "input" argument must be specified'), { code: "ERR_MISSING_ARGS" });
      }
      if (typeof input === "symbol") throw new NativeTypeError(runtime === "node" ? "Cannot convert a Symbol value to a string" : "Cannot convert a symbol to a string");
      // Coercion runs outside the codec catch, so application exceptions keep their identity.
      const text = nativeString(input);
      try { return Reflect.apply(codec, undefined, [text]); }
      catch (error) {
        if (!(error instanceof NativeDOMException) || error.name !== "InvalidCharacterError") throw error;
        let message = "The string contains invalid characters.";
        if (runtime === "node") {
          const compact = text.replace(/[\t\n\f\r ]/gu, "");
          const remainder = name === "atob" && /^[A-Za-z0-9+/]*={0,2}$/u.test(compact) && compact.replace(/=+$/u, "").length % 4 === 1;
          message = remainder ? "The string to be decoded is not correctly encoded." : "Invalid character";
        }
        throw new NativeDOMException(message, "InvalidCharacterError");
      }
    };
  }
  const decode = operation("atob"), encode = operation("btoa");
  return {
    atob: function atob(input?: unknown): unknown { return decode(input, arguments.length !== 0); },
    btoa: function btoa(input?: unknown): unknown { return encode(input, arguments.length !== 0); },
  };
}
