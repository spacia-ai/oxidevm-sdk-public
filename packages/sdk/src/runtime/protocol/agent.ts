import { boolean, exactKeys, integer, record, string } from "../decode.js";
import {
  type SerializedError,
  decodeSerializedError,
  VMError,
} from "../errors.js";
import { MAX_AGENT_OPERATION_BYTES, PROTOCOL_VERSION } from "./common.js";
import { decodeBytes } from "./decoders.js";

export interface AgentHello {
  readonly version: string;
  readonly capabilities: {
    readonly files: boolean;
    readonly processes: boolean;
  };
}

/** How a resumed guest's /workspace relates to the workspace store once it is reconciled. */
export interface ResumedWorkspace {
  readonly workspace: "in-sync" | "reconciled" | "conflict-preserved";
  /**
   * Store changes the guest could not take: paths the store returned to base content, which the
   * guest no longer holds. The guest keeps its own file there.
   */
  readonly unresolved: readonly string[];
}

export function decodeResumedWorkspace(value: unknown): ResumedWorkspace {
  const result = record(value, "resumed workspace");
  exactKeys(result, ["workspace", "unresolved"]);
  const workspace = result["workspace"];
  const unresolved: unknown = result["unresolved"];
  if (
    (workspace !== "in-sync" && workspace !== "reconciled" && workspace !== "conflict-preserved")
    || !Array.isArray(unresolved)
    || unresolved.length > 1_000_000
  ) {
    throw new VMError("PROTOCOL_ERROR", "resumed workspace result is invalid");
  }
  const paths: readonly unknown[] = unresolved;
  return { workspace, unresolved: paths.map(decodeWorkspaceChangePath) };
}

function decodeWorkspaceChangePath(value: unknown): string {
  const path = decodeAgentPath(value);
  if (path !== "/workspace" && !path.startsWith("/workspace/")) {
    throw new VMError("PROTOCOL_ERROR", "resumed workspace path is outside /workspace");
  }
  // These are canonical Linux guest paths, not browser workspace API input:
  // a backslash is an ordinary filename byte, never a separator.
  const encoder = new TextEncoder();
  if (encoder.encode(path).byteLength > 4096 || path.slice(1).split("/").some(part =>
    part === "" || part === "." || part === ".." || encoder.encode(part).byteLength > 255)) {
    throw new VMError("PROTOCOL_ERROR", "resumed workspace path is not canonical");
  }
  return path;
}

export interface AgentSpawnResult {
  readonly identityKey?:number;
  readonly pid: number;
  readonly sessionId: number;
  readonly terminal?: boolean;
}

export type ProcessTermination =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: number };

export type GuestProcessWireEvent =
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly sessionId: number;
      readonly sequence: number;
      readonly type: "stdout" | "stderr";
      readonly data: Uint8Array;
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly sessionId: number;
      readonly sequence: number;
      readonly type: "exit";
      readonly termination: ProcessTermination;
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly sessionId: number;
      readonly sequence: number;
      readonly type: "error";
      readonly error: SerializedError;
    };

export interface GuestProcessPortAck {
  readonly version: typeof PROTOCOL_VERSION;
  readonly sessionId: number;
  readonly type: "output-ack";
  readonly sequence: number;
}
export function decodeGuestProcessWireEvent(
  value: unknown,
): GuestProcessWireEvent {
  const event = record(value, "guest process event");
  const type = string(event["type"], "guest process event type");
  const base = decodeGuestProcessEventBase(event);
  switch (type) {
    case "stdout":
    case "stderr":
      exactKeys(event, [
        "version",
        "sessionId",
        "sequence",
        "type",
        "data",
      ]);
      return { ...base, type, data: decodeBytes(event["data"]) };
    case "exit": {
      exactKeys(event, ["version", "sessionId", "sequence", "type", "termination"]);
      return {
        ...base,
        type,
        termination: decodeProcessTermination(event["termination"]),
      };
    }
    case "error":
      exactKeys(event, [
        "version",
        "sessionId",
        "sequence",
        "type",
        "error",
      ]);
      return {
        ...base,
        type,
        error: decodeSerializedError(event["error"]),
      };
    default:
      throw new VMError(
        "PROTOCOL_ERROR",
        `unknown guest process event ${type}`,
      );
  }
}

export function decodeProcessTermination(value: unknown): ProcessTermination {
  const termination = record(value, "process termination");
  const kind = string(termination["kind"], "process termination kind");
  switch (kind) {
    case "exit":
      exactKeys(termination, ["kind", "code"]);
      return {
        kind,
        code: integer(termination["code"], "process exit code", 0, 255),
      };
    case "signal":
      exactKeys(termination, ["kind", "signal"]);
      return {
        kind,
        signal: integer(termination["signal"], "process signal", 1, 64),
      };
    default:
      throw new VMError("PROTOCOL_ERROR", "process termination kind is invalid");
  }
}

export function decodeGuestProcessPortAck(
  value: unknown,
): GuestProcessPortAck {
  const ack = record(value, "guest process acknowledgement");
  exactKeys(ack, ["version", "sessionId", "type", "sequence"]);
  if (
    integer(
      ack["version"],
      "protocol version",
      PROTOCOL_VERSION,
      PROTOCOL_VERSION,
    ) !== PROTOCOL_VERSION
  ) {
    throw new VMError("PROTOCOL_ERROR", "protocol version mismatch");
  }
  if (string(ack["type"], "acknowledgement type") !== "output-ack") {
    throw new VMError(
      "PROTOCOL_ERROR",
      "guest process acknowledgement type is invalid",
    );
  }
  return {
    version: PROTOCOL_VERSION,
    sessionId: integer(ack["sessionId"], "session id", 1),
    type: "output-ack",
    sequence: integer(ack["sequence"], "event sequence", 1),
  };
}

function decodeGuestProcessEventBase(
  event: Readonly<Record<string, unknown>>,
): {
  readonly version: typeof PROTOCOL_VERSION;
  readonly sessionId: number;
  readonly sequence: number;
} {
  if (
    integer(
      event["version"],
      "protocol version",
      PROTOCOL_VERSION,
      PROTOCOL_VERSION,
    ) !== PROTOCOL_VERSION
  ) {
    throw new VMError("PROTOCOL_ERROR", "protocol version mismatch");
  }
  return {
    version: PROTOCOL_VERSION,
    sessionId: integer(event["sessionId"], "session id", 1),
    sequence: integer(event["sequence"], "event sequence", 1),
  };
}

export function decodeAgentHello(value: unknown): AgentHello {
  const hello = record(value, "guest agent hello");
  exactKeys(hello, ["version", "capabilities"]);
  const capabilities = record(
    hello["capabilities"],
    "guest agent capabilities",
  );
  exactKeys(capabilities, ["files", "processes"]);
  return {
    version: string(hello["version"], "guest agent version"),
    capabilities: {
      files: boolean(capabilities["files"], "guest file capability"),
      processes: boolean(
        capabilities["processes"],
        "guest process capability",
      ),
    },
  };
}

export function decodeAgentSpawnResult(value: unknown): AgentSpawnResult {
  const result = record(value, "guest process spawn result");
  exactKeys(result, ["pid", "sessionId"], ["terminal","identityKey"]);
  return {
    ...(result["identityKey"]===undefined?{}:{identityKey:integer(result["identityKey"],"native stable attachment key",1,0xffff_ffff)}),
    pid: integer(result["pid"], "guest process id", 1, 0xffff_ffff),
    sessionId: integer(result["sessionId"], "guest process session id", 1),
    ...(result["terminal"] === undefined ? {} : { terminal: boolean(result["terminal"], "guest process terminal") }),
  };
}

export function decodeAgentPath(value: unknown): string {
  const path = string(value, "guest workspace path");
  if (path.length === 0 || path.includes("\0")) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "guest workspace path is invalid",
    );
  }
  return path;
}

export function decodeAgentCommand(value: unknown): string {
  const command = string(value, "guest command");
  if (command.length === 0 || command.includes("\0")) {
    throw new VMError("PROTOCOL_ERROR", "guest command is invalid");
  }
  return command;
}

export function decodeStringArray(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > 4096) {
    throw new VMError("PROTOCOL_ERROR", `${label} must be a bounded array`);
  }
  return value.map((entry, index) => {
    const decoded = string(entry, `${label}[${index}]`);
    if (decoded.includes("\0")) {
      throw new VMError(
        "PROTOCOL_ERROR",
        `${label}[${index}] contains NUL`,
      );
    }
    return decoded;
  });
}

export function decodeEnvironment(
  value: unknown,
): Readonly<Record<string, string>> {
  const environment = record(value, "guest process environment");
  const entries = Object.entries(environment);
  if (entries.length > 4096) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "guest process environment is too large",
    );
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "guest process environment key is invalid",
        );
      }
      const decoded = string(entry, `environment ${key}`);
      if (decoded.includes("\0")) {
        throw new VMError(
          "PROTOCOL_ERROR",
          `environment ${key} contains NUL`,
        );
      }
      return [key, decoded];
    }),
  );
}

export function validateAgentBytes(value: Uint8Array): void {
  if (value.byteLength > MAX_AGENT_OPERATION_BYTES) {
    throw new VMError(
      "PROTOCOL_ERROR",
      `guest agent payloads are limited to ${MAX_AGENT_OPERATION_BYTES / 1024 / 1024} MiB`,
    );
  }
}
