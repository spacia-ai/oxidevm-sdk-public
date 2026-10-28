import type { FeatureSupport } from "./contracts.js";
import { exactKeys, record, string } from "./runtime/decode.js";
import { decodeSerializedError, deserializeError, VMError, type VMErrorCode } from "./runtime/errors.js";
import { openExecutionFrame } from "./runtime/execution-frame.js";
import { isTrustworthyURL } from "./trustworthy-url.js";
import { sdkVersion } from "./sdk-version.js";

const DESCRIPTOR_BYTE_LIMIT = 4096;
const DESCRIPTOR_TIMEOUT_MS = 10_000;

/** The runtime publishes a native execution descriptor and its execution frame is open. */
export interface NativeExecutionOpen {
  readonly status: "open";
  readonly port: MessagePort;
  dispose(): void;
}

/** The runtime publishes no native-node-api.json (HTTP 404), so it offers no native execution. */
export interface NativeExecutionAbsent {
  readonly status: "absent";
  readonly reason: "descriptor-absent";
}

export type NativeExecutionResult = NativeExecutionOpen | NativeExecutionAbsent;

/** Shown once per VM whose `commandInterceptors: "auto"` opened without native execution. */
export const NATIVE_EXECUTION_ABSENT_WARNING = "OxideVM: native JavaScript acceleration is off because this runtime publishes no native-node-api.json (reason: descriptor-absent). Commands run in Linux, and TypeScript command interception stays as configured. To turn command acceleration and interception off on purpose, pass commandInterceptors: \"off\". To enable native acceleration, deploy a separate execution origin and publish its native-node-api.json beside this runtime.";

/** What the VM asked for: System mode has no command acceleration, and `"off"` opts out. */
export type CommandAccelerationRequest = "not-applicable" | "off" | "auto";

/** The public capability for the requested acceleration, given what the runtime actually opened. */
export function commandAccelerationSupport(request: CommandAccelerationRequest, native: NativeExecutionResult | undefined): FeatureSupport {
  switch (request) {
    case "not-applicable": return { available: false, reason: "mode-unsupported" };
    case "off": return { available: false, reason: "not-configured" };
    case "auto": return native?.status === "open" ? { available: true } : { available: false, reason: "runtime-unsupported" };
  }
}

/** Version 2 keeps hosted execution assets paired with the calling SDK. */
export function nativeExecutionURL(input: unknown, runtimeOrigin: string): URL {
  const descriptor = decodeDescriptor(input);
  if (descriptor.version !== 1 && descriptor.version !== 2) throw descriptorFailure("INVALID_ARGUMENT", "descriptor-version", "Native execution descriptor version is not supported");
  const origin = parseOrigin(descriptor.origin);
  if (!isTrustworthyURL(origin)) throw descriptorFailure("INVALID_ARGUMENT", "descriptor-origin-untrusted", "Native execution needs a trustworthy origin");
  if (origin.origin !== origin.href.replace(/\/$/u, "")) throw descriptorFailure("INVALID_ARGUMENT", "descriptor-origin-invalid", "Native execution origin must be an origin without a path");
  if (origin.origin === runtimeOrigin) throw descriptorFailure("INVALID_ARGUMENT", "descriptor-origin-runtime", "Native execution needs a separate origin from the runtime");
  return new URL(`${descriptor.version === 2 ? `/v/${sdkVersion}` : ""}/oxidevm-native-process/index.html`, origin);
}

/**
 * Opens the runtime's native execution. A 404 descriptor means the runtime offers none (`absent`). Every
 * other failure is a typed error with a stable `detail.reason`, and never a raw DOM or parser exception.
 */
export async function openNativeExecution(baseUrl: string, signal?: AbortSignal): Promise<NativeExecutionResult> {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") throw descriptorFailure("FEATURE_NOT_AVAILABLE", "cross-origin-isolation", "Native JavaScript acceleration requires cross-origin isolation");
  const timeout = AbortSignal.timeout(DESCRIPTOR_TIMEOUT_MS);
  const request = { signal, timeout, requestSignal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) };
  const text = await readDescriptor(descriptorURL(baseUrl), request);
  if (text === undefined) return { status: "absent", reason: "descriptor-absent" };
  const input = parseDescriptor(text);
  const connection = await openExecutionFrame(nativeExecutionURL(input, location.origin), (port, nonce) => ({ version: 1, type: "native-bootstrap", nonce, port }), (input, nonce) => {
    const message = record(input, "native execution bootstrap");
    if (message["type"] === "failure") { exactKeys(message, ["version", "type", "nonce", "error"]); if (message["version"] !== 1 || message["nonce"] !== nonce) throw bindingMismatch(); throw deserializeError(decodeSerializedError(message["error"])); }
    exactKeys(message, ["version", "type", "nonce"]);
    if (message["version"] !== 1 || message["type"] !== "native-ready" || message["nonce"] !== nonce) throw bindingMismatch();
  }, signal);
  return { status: "open", port: connection.port, dispose: () => connection.dispose() };
}

interface DescriptorRequest {
  readonly signal: AbortSignal | undefined;
  readonly timeout: AbortSignal;
  readonly requestSignal: AbortSignal;
}

/**
 * The descriptor's text, or `undefined` when the runtime publishes none. That is a 404, or a successful answer
 * that is an HTML page: self-hosted hosts serve their app shell for unknown paths. Other failures stay typed.
 */
async function readDescriptor(url: URL, request: DescriptorRequest): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: request.requestSignal, credentials: "omit" });
    if (publishesNoDescriptor(response)) {
      await discardBody(response);
      return undefined;
    }
    if (!response.ok) {
      await discardBody(response);
      throw descriptorFailure("FEATURE_NOT_AVAILABLE", "descriptor-unavailable", "The runtime's native-node-api.json could not be read", { status: response.status });
    }
    return await readBoundedText(response);
  } catch (error: unknown) {
    if (error instanceof VMError) throw error;
    throw requestFailure(error, request);
  }
}

function publishesNoDescriptor(response: Response): boolean {
  if (response.status === 404) return true;
  const type = response.headers.get("content-type");
  return response.ok && type !== null && type.trim().toLowerCase().startsWith("text/html");
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Reads the descriptor's UTF-8 bytes as they arrive, and stops at the first byte past the limit, so a hostile
 * runtime cannot make the SDK buffer an unbounded body. The bytes must decode as strict UTF-8.
 */
async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > DESCRIPTOR_BYTE_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw descriptorFailure("PROTOCOL_ERROR", "descriptor-too-large", "Native execution descriptor exceeds its limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw descriptorFailure("PROTOCOL_ERROR", "descriptor-malformed", "Native execution descriptor is not UTF-8");
  }
}

function requestFailure(error: unknown, request: DescriptorRequest): VMError {
  if (request.signal?.aborted === true) return new VMError("ABORTED", "Native execution descriptor request was cancelled");
  if (request.timeout.aborted || error instanceof DOMException && error.name === "TimeoutError") return descriptorFailure("FEATURE_NOT_AVAILABLE", "descriptor-timeout", "The runtime did not answer native-node-api.json in time");
  return descriptorFailure("FEATURE_NOT_AVAILABLE", "descriptor-unreachable", "The runtime's native-node-api.json could not be fetched");
}

function descriptorURL(baseUrl: string): URL {
  try {
    return new URL("native-node-api.json", new URL(baseUrl, location.href));
  } catch {
    throw descriptorFailure("INVALID_ARGUMENT", "runtime-base-invalid", "The runtime base URL is not a valid URL");
  }
}

function parseDescriptor(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw descriptorFailure("PROTOCOL_ERROR", "descriptor-malformed", "Native execution descriptor is not JSON");
  }
}

function decodeDescriptor(input: unknown): { readonly version: unknown; readonly origin: string } {
  try {
    const descriptor = record(input, "native execution descriptor");
    exactKeys(descriptor, ["version", "origin"]);
    return { version: descriptor["version"], origin: string(descriptor["origin"], "execution origin") };
  } catch (error: unknown) {
    throw descriptorFailure("PROTOCOL_ERROR", "descriptor-malformed", error instanceof Error ? error.message : "Native execution descriptor is malformed");
  }
}

function parseOrigin(text: string): URL {
  try {
    return new URL(text);
  } catch {
    throw descriptorFailure("INVALID_ARGUMENT", "descriptor-origin-invalid", "Native execution origin is not a URL");
  }
}

function bindingMismatch(): VMError {
  return descriptorFailure("PROTOCOL_ERROR", "native-binding-mismatch", "Native execution binding mismatch");
}

function descriptorFailure(code: VMErrorCode, reason: string, message: string, detail: Readonly<Record<string, unknown>> = {}): VMError {
  return new VMError(code, message, { ...detail, reason });
}
