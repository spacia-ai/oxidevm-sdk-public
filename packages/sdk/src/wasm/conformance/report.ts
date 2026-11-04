import { exactKeys, integer, protocolError, record, string } from "../../runtime/decode.js";
import { MODULE_ISOLATION_CAPABILITIES, MODULE_ISOLATION_REASON, type ModuleIsolationCapability } from "../../runtime/protocol/module-isolation.js";

/** The runner-contract properties `oxidevm wasm test` checks, in the order it checks them. */
export const WASM_TEST_PROPERTIES = [
  "integrity", "exit-range", "ready", "endpoints", "duplicate-start", "snapshot-refused", "eof-stop", "restart", "kill-recover", "declared-host",
  "network-direct", "network-declared", "network-offline",
] as const;
export type WasmTestProperty = (typeof WASM_TEST_PROPERTIES)[number];
export type WasmPropertyStatus = "passed" | "failed" | "not-applicable";

export interface WasmPropertyResult {
  readonly property: WasmTestProperty;
  readonly status: WasmPropertyStatus;
  /** Why it failed or does not apply; absent for a pass. */
  readonly message?: string;
  readonly elapsedMs: number;
}

/**
 * Why the module could not run at all, so no property was checked. Both are `FEATURE_NOT_AVAILABLE` from `spawnModule`:
 * the browser cannot isolate module workers (engine ADR 0028; `capability` is the closed name of what failed), or the
 * browser or image lacks something the manifest requires (`missing`, as the runner names it).
 */
export type WasmTestRefusal =
  | { readonly code: "FEATURE_NOT_AVAILABLE"; readonly reason: typeof MODULE_ISOLATION_REASON; readonly capability: ModuleIsolationCapability; readonly message: string }
  | { readonly code: "FEATURE_NOT_AVAILABLE"; readonly reason: typeof PREREQUISITE_REASON; readonly missing: readonly string[]; readonly message: string };

/**
 * `result` is `passed` (exit 0), `failed` (a property failed, exit 3) or `refused` (exit 4): the module could not run in
 * this browser or image, `refusal` says why, and every property is `not-applicable`. Only a refused report has
 * `refusal`; passed and failed reports are as before, so schema version 1 stands.
 */
export interface WasmTestReport {
  readonly schemaVersion: 1;
  readonly result: "passed" | "failed" | "refused";
  readonly refusal?: WasmTestRefusal;
  readonly module: { readonly id: string; readonly version: string; readonly kind: "command" | "service"; readonly release: string };
  readonly sdkVersion: string;
  readonly engineRelease: string;
  readonly browser: { readonly name: "chromium" | "firefox" | "webkit"; readonly version: string };
  readonly image: { readonly manifestSHA256: string };
  readonly properties: readonly WasmPropertyResult[];
}

/** Bounds every text that crosses from the page, so a module cannot flood the report. */
export const MAX_MESSAGE_LENGTH = 2048;
const MAX_FIELD_LENGTH = 256;
const MAX_MISSING = 64;
/** `MODULE_EXIT_REASONS.prerequisite`, as a literal type. */
export const PREREQUISITE_REASON = "wasm-module-prerequisite";

function bounded(value: unknown, label: string, maximum: number): string {
  const text = string(value, label);
  if (text.length > maximum) throw protocolError(`${label} is longer than ${String(maximum)} characters`);
  return text;
}

function oneOf<const T extends string>(value: unknown, label: string, choices: readonly T[]): T {
  const found = choices.find(choice => choice === value);
  if (found === undefined) throw protocolError(`${label} must be one of ${choices.join(", ")}`);
  return found;
}

export function decodeWasmPropertyResult(value: unknown): WasmPropertyResult {
  const item = record(value, "property result");
  exactKeys(item, ["property", "status", "elapsedMs"], ["message"]);
  const property = oneOf(item["property"], "property", WASM_TEST_PROPERTIES);
  const status = oneOf(item["status"], "property status", ["passed", "failed", "not-applicable"] as const);
  const elapsedMs = integer(item["elapsedMs"], "elapsedMs", 0, 24 * 60 * 60 * 1000);
  if (item["message"] === undefined) {
    if (status !== "passed") throw protocolError(`${property} needs a message when it is ${status}`);
    return { property, status, elapsedMs };
  }
  return { property, status, message: bounded(item["message"], "property message", MAX_MESSAGE_LENGTH), elapsedMs };
}

/** The properties of a refused run: none was checked, and each says why. */
export function refusedProperties(refusal: WasmTestRefusal): readonly WasmPropertyResult[] {
  const message = `not run: the browser refused the module (${refusal.reason}, ${"capability" in refusal ? refusal.capability : refusal.missing.join(", ")})`;
  return WASM_TEST_PROPERTIES.map(property => ({ property, status: "not-applicable", message: message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`, elapsedMs: 0 }));
}

export function decodeWasmTestRefusal(value: unknown): WasmTestRefusal {
  const item = record(value, "refusal");
  const reason = oneOf(item["reason"], "refusal reason", [MODULE_ISOLATION_REASON, PREREQUISITE_REASON]);
  if (item["code"] !== "FEATURE_NOT_AVAILABLE") throw protocolError("a refusal's code must be FEATURE_NOT_AVAILABLE");
  const message = bounded(item["message"], "refusal message", MAX_MESSAGE_LENGTH);
  if (reason === MODULE_ISOLATION_REASON) {
    exactKeys(item, ["code", "reason", "capability", "message"]);
    return { code: "FEATURE_NOT_AVAILABLE", reason, capability: oneOf(item["capability"], "refusal capability", MODULE_ISOLATION_CAPABILITIES), message };
  }
  exactKeys(item, ["code", "reason", "missing", "message"]);
  const listed: unknown = item["missing"];
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > MAX_MISSING) throw protocolError(`a prerequisite refusal names 1 to ${String(MAX_MISSING)} missing items`);
  return { code: "FEATURE_NOT_AVAILABLE", reason: PREREQUISITE_REASON, missing: Array.from<unknown>(listed).map(entry => bounded(entry, "missing item", MAX_FIELD_LENGTH)), message };
}

/** Decodes a whole report: every property exactly once, in catalog order, and a result that agrees with them. */
export function decodeWasmTestReport(value: unknown): WasmTestReport {
  const item = record(value, "wasm test report");
  exactKeys(item, ["schemaVersion", "result", "module", "sdkVersion", "engineRelease", "browser", "image", "properties"], ["refusal"]);
  if (item["schemaVersion"] !== 1) throw protocolError("unknown wasm test report schema");
  const module = record(item["module"], "module");
  exactKeys(module, ["id", "version", "kind", "release"]);
  const browser = record(item["browser"], "browser");
  exactKeys(browser, ["name", "version"]);
  const image = record(item["image"], "image");
  exactKeys(image, ["manifestSHA256"]);
  const listed: unknown = item["properties"];
  if (!Array.isArray(listed) || listed.length !== WASM_TEST_PROPERTIES.length) throw protocolError(`the report must list all ${String(WASM_TEST_PROPERTIES.length)} properties`);
  const properties = Array.from<unknown>(listed).map(decodeWasmPropertyResult);
  if (properties.some((result, index) => result.property !== WASM_TEST_PROPERTIES[index])) throw protocolError("the report lists the properties out of order");
  const result = oneOf(item["result"], "result", ["passed", "failed", "refused"] as const);
  let refusal: WasmTestRefusal | undefined;
  if (result === "refused") {
    if (item["refusal"] === undefined) throw protocolError("a refused report needs its refusal");
    refusal = decodeWasmTestRefusal(item["refusal"]);
    if (properties.some(entry => entry.status !== "not-applicable")) throw protocolError("a refused report ran no property, so each is not-applicable");
  } else {
    if (item["refusal"] !== undefined) throw protocolError("only a refused report has a refusal");
    if ((result === "failed") !== properties.some(entry => entry.status === "failed")) throw protocolError("the report result disagrees with its properties");
  }
  return {
    schemaVersion: 1, result, ...(refusal === undefined ? {} : { refusal }),
    module: { id: bounded(module["id"], "module id", MAX_FIELD_LENGTH), version: bounded(module["version"], "module version", MAX_FIELD_LENGTH), kind: oneOf(module["kind"], "module kind", ["command", "service"] as const), release: bounded(module["release"], "release", MAX_FIELD_LENGTH) },
    sdkVersion: bounded(item["sdkVersion"], "sdkVersion", MAX_FIELD_LENGTH),
    engineRelease: bounded(item["engineRelease"], "engineRelease", MAX_FIELD_LENGTH),
    browser: { name: oneOf(browser["name"], "browser name", ["chromium", "firefox", "webkit"] as const), version: bounded(browser["version"], "browser version", MAX_FIELD_LENGTH) },
    image: { manifestSHA256: bounded(image["manifestSHA256"], "image digest", MAX_FIELD_LENGTH) },
    properties,
  };
}
