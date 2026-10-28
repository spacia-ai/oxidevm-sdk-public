import { exactKeys, integer } from "../decode.js";
import { VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "./common.js";
export interface RequestBase {
  readonly id: number;
  readonly version: typeof PROTOCOL_VERSION;
}

export interface CancelRequest {
  readonly version: typeof PROTOCOL_VERSION;
  readonly type: "cancel";
  readonly requestId: number;
}

export function decodeMessagePort(value: unknown, name: string): MessagePort {
  if (!(value instanceof MessagePort)) {
    throw new VMError("PROTOCOL_ERROR", `${name} is invalid`);
  }
  return value;
}

export function decodeDiskBridge(
  message: Readonly<Record<string, unknown>>,
):
  | {
      readonly diskBridge: SharedArrayBuffer;
      readonly diskPort: InstanceType<typeof MessagePort>;
    }
  | Record<never, never> {
  const buffer = message["diskBridge"];
  const port = message["diskPort"];
  if (buffer === undefined && port === undefined) return {};
  if (
    typeof SharedArrayBuffer !== "function" ||
    !(buffer instanceof SharedArrayBuffer) ||
    !(port instanceof MessagePort)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "host disk bridge and port must be supplied together",
    );
  }
  return { diskBridge: buffer, diskPort: port };
}

export function decodeRequestBase(
  message: Readonly<Record<string, unknown>>,
): RequestBase {
  const version = integer(
    message["version"],
    "protocol version",
    PROTOCOL_VERSION,
    PROTOCOL_VERSION,
  );
  if (version !== PROTOCOL_VERSION) {
    throw new VMError("PROTOCOL_ERROR", "protocol version mismatch");
  }
  return {
    id: integer(message["id"], "request id", 1),
    version: PROTOCOL_VERSION,
  };
}

export function decodeCancel(
  message: Readonly<Record<string, unknown>>,
): CancelRequest {
  exactKeys(message, ["version", "type", "requestId"]);
  const version = integer(
    message["version"],
    "protocol version",
    PROTOCOL_VERSION,
    PROTOCOL_VERSION,
  );
  if (version !== PROTOCOL_VERSION) {
    throw new VMError("PROTOCOL_ERROR", "protocol version mismatch");
  }
  return {
    version: PROTOCOL_VERSION,
    type: "cancel",
    requestId: integer(message["requestId"], "request id", 1),
  };
}
