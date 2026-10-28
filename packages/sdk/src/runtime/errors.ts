export type VMErrorCode =
  | "ABORTED"
  | "CORE_LOAD_FAILED"
  | "FEATURE_NOT_AVAILABLE"
  | "GUEST_CRASH"
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "PROTOCOL_ERROR"
  | "QUOTA_EXCEEDED"
  | "RELAY_ERROR"
  | "SNAPSHOT_VERSION"
  | "STORAGE_ERROR"
  | "STORAGE_NOT_FOUND"
  | "UNSUPPORTED_INSTRUCTION"
  | "UNSUPPORTED_SYSCALL"
  | "VM_FAULT";

const ERROR_CODES: ReadonlySet<string> = new Set<VMErrorCode>([
  "ABORTED",
  "CORE_LOAD_FAILED",
  "FEATURE_NOT_AVAILABLE",
  "GUEST_CRASH",
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "PROTOCOL_ERROR",
  "QUOTA_EXCEEDED",
  "RELAY_ERROR",
  "SNAPSHOT_VERSION",
  "STORAGE_ERROR",
  "STORAGE_NOT_FOUND",
  "UNSUPPORTED_INSTRUCTION",
  "UNSUPPORTED_SYSCALL",
  "VM_FAULT",
]);

const WASM_TRAP_STACK_LIMIT = 8 * 1024;
const ownedErrors = new WeakSet<object>();
const hasOwnedError = ownedErrors.has.bind(ownedErrors), registerOwnedError = ownedErrors.add.bind(ownedErrors);

export class VMError extends Error {
  readonly code: VMErrorCode;
  readonly detail: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: VMErrorCode,
    message: string,
    detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "VMError";
    this.code = code;
    this.detail = detail;
    registerOwnedError(this);
  }
}

/** Checks SDK ownership without reading application prototypes or changing the public error shape. */
export function isVMError(value: unknown): value is VMError {
  return typeof value === "object" && value !== null && hasOwnedError(value);
}

export interface SerializedError {
  code: VMErrorCode;
  message: string;
  detail?: Readonly<Record<string, unknown>>;
}

export function deserializeError(error: SerializedError): VMError {
  return new VMError(error.code, error.message, error.detail);
}

export function decodeSerializedError(value: unknown): SerializedError {
  if (!isRecord(value)) {
    throw new VMError("PROTOCOL_ERROR", "worker error must be an object");
  }
  const keys = Object.keys(value);
  if (
    !Object.hasOwn(value, "code") ||
    !Object.hasOwn(value, "message") ||
    keys.some((key) => key !== "code" && key !== "message" && key !== "detail")
  ) {
    throw new VMError("PROTOCOL_ERROR", "worker error has invalid fields");
  }
  const code = value["code"];
  const message = value["message"];
  const detail = value["detail"];
  if (typeof code !== "string" || !ERROR_CODES.has(code)) {
    throw new VMError("PROTOCOL_ERROR", "worker error code is invalid");
  }
  if (typeof message !== "string") {
    throw new VMError("PROTOCOL_ERROR", "worker error message is invalid");
  }
  if (
    detail !== undefined &&
    !isRecord(detail)
  ) {
    throw new VMError("PROTOCOL_ERROR", "worker error detail is invalid");
  }

  return {
    code: decodeErrorCode(code),
    message,
    ...(detail === undefined ? {} : { detail }),
  };
}

export function serializeUnknownError(error: unknown): SerializedError {
  if (error instanceof VMError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
  if (isWasmRuntimeError(error)) {
    const rawStack = error.stack;
    const stack = typeof rawStack === "string" ? rawStack : null;
    return {
      code: "PROTOCOL_ERROR",
      message: error.message,
      detail: {
        wasmTrap: {
          stack: stack === null ? null : stack.slice(0, WASM_TRAP_STACK_LIMIT),
          truncated: stack !== null && stack.length > WASM_TRAP_STACK_LIMIT,
        },
      },
    };
  }
  return {
    code: "PROTOCOL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Keeps a failure's code, message and detail when cleaning up after it also fails. */
export function withCleanupFailure(failure: unknown, cleanup: unknown): VMError {
  const original = serializeUnknownError(failure);
  return new VMError(original.code, original.message, { ...original.detail, cleanupFailed: true, cleanupError: serializeUnknownError(cleanup) });
}

export function normalizeStorageError(error: unknown): VMError {
  if (error instanceof VMError) return error;

  const name = error instanceof DOMException ? error.name : undefined;
  const code =
    name === "NotFoundError"
      ? "STORAGE_NOT_FOUND"
      : name === "QuotaExceededError"
        ? "QUOTA_EXCEEDED"
        : name === "NotAllowedError" || name === "SecurityError"
          ? "PERMISSION_DENIED"
          : "STORAGE_ERROR";
  if (code === "PERMISSION_DENIED") {
    return new VMError(code, "Browser storage access is blocked. Allow site storage for this application and its runtime, then retry.", { name, reason: "browser-storage-blocked" });
  }
  return new VMError(
    code,
    error instanceof Error ? error.message : String(error),
    name === undefined ? undefined : { name },
  );
}

function decodeErrorCode(value: string): VMErrorCode {
  switch (value) {
    case "ABORTED":
    case "CORE_LOAD_FAILED":
    case "FEATURE_NOT_AVAILABLE":
    case "GUEST_CRASH":
    case "INVALID_ARGUMENT":
    case "PERMISSION_DENIED":
    case "PROTOCOL_ERROR":
    case "QUOTA_EXCEEDED":
    case "RELAY_ERROR":
    case "SNAPSHOT_VERSION":
    case "STORAGE_ERROR":
    case "STORAGE_NOT_FOUND":
    case "UNSUPPORTED_INSTRUCTION":
    case "UNSUPPORTED_SYSCALL":
    case "VM_FAULT":
      return value;
  }
  throw new VMError("PROTOCOL_ERROR", "worker error code is invalid");
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWasmRuntimeError(error: unknown): error is Error {
  const wasm: unknown = Reflect.get(globalThis, "WebAssembly");
  const constructor = isRecord(wasm) ? wasm["RuntimeError"] : undefined;
  return error instanceof Error && typeof constructor === "function" && error instanceof constructor;
}
