import { exactKeys, integer, protocolError, record, string } from "../../runtime/decode.js";

/** The runner-contract properties `oxidevm wasm test` checks, in the order it checks them. */
export const WASM_TEST_PROPERTIES = [
  "integrity", "exit-range", "ready", "endpoints", "duplicate-start", "snapshot-refused", "eof-stop", "restart", "kill-recover", "declared-host",
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

export interface WasmTestReport {
  readonly schemaVersion: 1;
  readonly result: "passed" | "failed";
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

/** Decodes a whole report: every property exactly once, in catalog order, and a result that agrees with them. */
export function decodeWasmTestReport(value: unknown): WasmTestReport {
  const item = record(value, "wasm test report");
  exactKeys(item, ["schemaVersion", "result", "module", "sdkVersion", "engineRelease", "browser", "image", "properties"]);
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
  const result = oneOf(item["result"], "result", ["passed", "failed"] as const);
  if ((result === "failed") !== properties.some(entry => entry.status === "failed")) throw protocolError("the report result disagrees with its properties");
  return {
    schemaVersion: 1, result,
    module: { id: bounded(module["id"], "module id", MAX_FIELD_LENGTH), version: bounded(module["version"], "module version", MAX_FIELD_LENGTH), kind: oneOf(module["kind"], "module kind", ["command", "service"] as const), release: bounded(module["release"], "release", MAX_FIELD_LENGTH) },
    sdkVersion: bounded(item["sdkVersion"], "sdkVersion", MAX_FIELD_LENGTH),
    engineRelease: bounded(item["engineRelease"], "engineRelease", MAX_FIELD_LENGTH),
    browser: { name: oneOf(browser["name"], "browser name", ["chromium", "firefox", "webkit"] as const), version: bounded(browser["version"], "browser version", MAX_FIELD_LENGTH) },
    image: { manifestSHA256: bounded(image["manifestSHA256"], "image digest", MAX_FIELD_LENGTH) },
    properties,
  };
}
