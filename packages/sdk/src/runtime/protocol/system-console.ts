import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { MAX_SYSTEM_CONSOLE_INPUT_BYTES, PROTOCOL_VERSION } from "./common.js";
import { decodeBytes, decodeUndefined } from "./decoders.js";

export interface SystemConsoleOperations {
  readonly "write-system-console": { readonly request: { readonly data: Uint8Array }; readonly response: undefined };
  readonly "resize-system-console": {
    readonly request: { readonly columns: number; readonly rows: number };
    readonly response: undefined;
  };
}
type Base = { readonly id: number; readonly version: typeof PROTOCOL_VERSION };
export type SystemConsoleRequest = Base & (
  | { readonly type: "write-system-console"; readonly data: Uint8Array }
  | { readonly type: "resize-system-console"; readonly columns: number; readonly rows: number }
);

export const systemConsoleResponseDecoders = {
  "write-system-console": decodeUndefined,
  "resize-system-console": decodeUndefined,
};

export function isSystemConsoleControl(type: string): type is keyof SystemConsoleOperations {
  return type === "write-system-console" || type === "resize-system-console";
}

export function decodeSystemConsoleControl(value: unknown): SystemConsoleRequest {
  const input = record(value, "system console request");
  const id = integer(input["id"], "request id", 1);
  integer(input["version"], "protocol version", PROTOCOL_VERSION, PROTOCOL_VERSION);
  const base: Base = { id, version: PROTOCOL_VERSION };
  const type = string(input["type"], "system console operation");
  switch (type) {
    case "write-system-console": {
      exactKeys(input, ["id", "version", "type", "data"]);
      const data = decodeBytes(input["data"]);
      validateSystemConsoleInput(data.byteLength);
      return { ...base, type, data };
    }
    case "resize-system-console":
      exactKeys(input, ["id", "version", "type", "columns", "rows"]);
      return {
        ...base, type,
        columns: integer(input["columns"], "terminal columns", 1, 1000),
        rows: integer(input["rows"], "terminal rows", 1, 1000),
      };
    default:
      throw new VMError("PROTOCOL_ERROR", "unknown system console operation");
  }
}

export function validateSystemConsoleInput(bytes: number): void {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_SYSTEM_CONSOLE_INPUT_BYTES) {
    throw new VMError("INVALID_ARGUMENT", `console writes must be 1 to ${MAX_SYSTEM_CONSOLE_INPUT_BYTES / 1024} KiB`);
  }
}
