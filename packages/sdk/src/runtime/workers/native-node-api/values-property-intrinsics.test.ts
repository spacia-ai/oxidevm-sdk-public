import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const operations = [
  ["napi_get_element", "get"], ["napi_get_named_property", "get"], ["napi_get_property", "get"],
  ["napi_has_element", "has"], ["napi_has_named_property", "has"], ["napi_has_property", "has"],
  ["napi_delete_element", "deleteProperty"], ["napi_delete_property", "deleteProperty"],
] as const;
for (const runtime of ["node", "bun"] as const) for (const poison of ["replacement", "getter"] as const) for (const [operation, method] of operations) {
  it(`${runtime} ${operation} ignores application Reflect.${method} ${poison}`, () => {
    const values = new NativeValues(() => undefined, () => undefined, () => undefined, 0, () => undefined,
      { claim: () => undefined, retire: () => undefined, runtime });
    const target = { "7": 17 }, targetId = values.add(target), keyId = values.add("7");
    const named = operation.includes("_named_"), indexed = operation.endsWith("_element");
    const args = named ? [targetId] : [targetId, indexed ? 7n : keyId], bytes = named ? new TextEncoder().encode("7") : new Uint8Array();
    const reflect = Reflect, define = Object.defineProperty, original = Object.getOwnPropertyDescriptor(reflect, method);
    if (original === undefined) throw new Error("Missing intrinsic descriptor");
    let traps = 0; const marker = new Error("application Reflect replacement");
    const replacement = () => { traps++; throw marker; };
    define(reflect, method, poison === "replacement" ? { configurable: true, value: replacement }
      : { configurable: true, get() { traps++; return replacement; } });
    let result: ReturnType<NativeValues["dispatch"]>;
    try { result = values.dispatch(operation, args, bytes); }
    finally { define(reflect, method, original); }
    expect(result.status).toBe(0); expect(traps).toBe(0);
    const output = result.args[0]; if (output === undefined) throw new Error("Missing operation result");
    if (method === "get") expect(values.get(output)).toBe(17);
    else expect(output).toBe(1n);
    if (method === "deleteProperty") expect(Object.hasOwn(target, "7")).toBe(false);
    values.dispose();
  });
}
