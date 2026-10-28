import type { ModuleFormat } from "./module-files.ts";

/** Dynamic import options follow ordinary property access (including getters),
 * but only own enumerable string attributes enter the module request. */
export function importAttributes(options: unknown): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (options === undefined) return result;
  if (!isObject(options)) throw new TypeError("import() options must be an object");
  const attributes: unknown = Reflect.get(options, "with");
  if (attributes === undefined) return result;
  if (!isObject(attributes)) throw new TypeError("import() attributes must be an object");
  for (const key of Object.keys(attributes)) {
    const value: unknown = Reflect.get(attributes, key);
    if (typeof value !== "string") throw new TypeError("Import attribute values must be strings");
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}

export function validateImportAttributes(attributes: Readonly<Record<string, string>>, format: ModuleFormat, path: string): void {
  const type = Object.hasOwn(attributes, "type") ? attributes["type"] : undefined;
  for (const key of Object.keys(attributes)) {
    if (key !== "type" || attributes[key] !== "json") {
      throw failure("ERR_IMPORT_ATTRIBUTE_UNSUPPORTED", `Unsupported import attribute ${key}=${attributes[key]} for ${path}`);
    }
  }
  if (format === "json" && type !== "json") {
    throw failure("ERR_IMPORT_ATTRIBUTE_MISSING", `JSON module ${path} requires type: json`);
  }
  if (format !== "json" && type === "json") {
    throw failure("ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE", `Module ${path} is not JSON`);
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
function failure(code: string, message: string): TypeError {
  return Object.assign(new TypeError(message), { code });
}
