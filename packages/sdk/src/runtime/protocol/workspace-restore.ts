import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeBytes } from "./decoders.js";

export type WorkspaceRestore =
  | { readonly kind: "begin-dependencies"; readonly transfer: number; readonly bytes: number; readonly generation: Uint8Array; readonly inputs: Uint8Array }
  | { readonly kind: "begin"; readonly transfer: number; readonly format: "snapshot" | "delta"; readonly bytes: number }
  | { readonly kind: "chunk"; readonly transfer: number; readonly offset: number; readonly sha256: Uint8Array; readonly data: Uint8Array }
  | { readonly kind: "commit" | "abort" | "status"; readonly transfer: number };

/** The guest's answer to a status request after a commit: the apply is still
 * running (with the entries applied so far), finished, or failed with the
 * agent's error text. */
export type RestoreStatus =
  | { readonly state: "applying"; readonly applied: number; readonly total: number }
  | { readonly state: "done"; readonly applied: number; readonly total: number }
  | { readonly state: "failed"; readonly applied: number; readonly total: number; readonly error: string };

export type WorkspaceRestoreTarget = "snapshot" | "delta"
  | { readonly kind: "dependencies"; readonly generation: Uint8Array; readonly inputs: Uint8Array };

function versionSeven(version: number): void {
  if (version !== 7) throw new VMError("PROTOCOL_ERROR", "Streamed restoration requires guest seven");
}

function operation(value: unknown): WorkspaceRestore {
  const input = record(value, "workspace restore");
  const transfer = integer(input["transfer"], "restore transfer", 1, 0xffff_ffff);
  const kind = input["kind"];
  switch (kind) {
    case "begin-dependencies": {
      exactKeys(input, ["kind", "transfer", "bytes", "generation", "inputs"]);
      const generation = decodeBytes(input["generation"]);
      const inputs = decodeBytes(input["inputs"]);
      if (generation.byteLength !== 32 || inputs.byteLength !== 32) throw new VMError("PROTOCOL_ERROR", "Invalid dependency identity");
      return { kind, transfer, bytes: integer(input["bytes"], "dependency restore bytes", 12, 1024 ** 4), generation, inputs };
    }
    case "begin": {
      exactKeys(input, ["kind", "transfer", "format", "bytes"]);
      const format = input["format"];
      if (format !== "snapshot" && format !== "delta") throw new VMError("PROTOCOL_ERROR", "Invalid restore format");
      return { kind, transfer, format, bytes: integer(input["bytes"], "restore bytes", 12, 1024 ** 4) };
    }
    case "chunk": {
      exactKeys(input, ["kind", "transfer", "offset", "sha256", "data"]);
      const offset = integer(input["offset"], "restore offset", 0, 1024 ** 4);
      const sha256 = decodeBytes(input["sha256"]);
      const data = decodeBytes(input["data"]);
      if (sha256.byteLength !== 32 || data.byteLength === 0 || data.byteLength > 65_536 || offset + data.byteLength > 1024 ** 4) {
        throw new VMError("PROTOCOL_ERROR", "Invalid restore chunk");
      }
      return { kind, transfer, offset, sha256, data };
    }
    case "commit": case "abort": case "status":
      exactKeys(input, ["kind", "transfer"]);
      return { kind, transfer };
    default: throw new VMError("PROTOCOL_ERROR", "Invalid restore operation");
  }
}

export function encodeWorkspaceRestore(value: unknown, version: number): Uint8Array<ArrayBuffer> {
  versionSeven(version);
  const input = operation(value);
  const output = new AgentPayloadWriter(53 + 65_536);
  switch (input.kind) {
    case "begin-dependencies": output.u8(5).u32(input.transfer).u64(BigInt(input.bytes)).bytes(input.generation).bytes(input.inputs); break;
    case "begin": output.u8(1).u32(input.transfer).u8(input.format === "snapshot" ? 0 : 1).u64(BigInt(input.bytes)); break;
    case "chunk": output.u8(2).u32(input.transfer).u64(BigInt(input.offset)).bytes(input.sha256).bytes(input.data); break;
    case "commit": output.u8(3).u32(input.transfer); break;
    case "abort": output.u8(4).u32(input.transfer); break;
    case "status": output.u8(6).u32(input.transfer); break;
  }
  return output.finish();
}

export function decodeWorkspaceRestore(bytes: Uint8Array, version: number): WorkspaceRestore {
  versionSeven(version);
  if (bytes.byteLength > 53 + 65_536) throw new VMError("PROTOCOL_ERROR", "Restore request exceeds limit");
  const input = new AgentPayloadReader(bytes);
  const kind = input.u8();
  const transfer = input.u32();
  let value: unknown;
  switch (kind) {
    case 5: value = { kind: "begin-dependencies", transfer, bytes: Number(input.u64()), generation: input.bytes(), inputs: input.bytes() }; break;
    case 1: {
      const format = input.u8();
      value = { kind: "begin", transfer, format: format === 0 ? "snapshot" : format === 1 ? "delta" : undefined, bytes: Number(input.u64()) };
      break;
    }
    case 2: value = { kind: "chunk", transfer, offset: Number(input.u64()), sha256: input.bytes(), data: input.bytes() }; break;
    case 3: value = { kind: "commit", transfer }; break;
    case 4: value = { kind: "abort", transfer }; break;
    case 6: value = { kind: "status", transfer }; break;
    default: throw new VMError("PROTOCOL_ERROR", "Invalid restore operation");
  }
  input.finish();
  return operation(value);
}

/** A guest-7 dependency begin answers one byte: 0 to receive the stream, 1 when
 * the committed generation already carries that identity. Workspace begins
 * stay empty. Anything else is a protocol violation. */
export function decodeRestoreBegun(payload: Uint8Array, dependencies: boolean): "receive" | "current" {
  if (!dependencies) {
    if (payload.byteLength !== 0) throw new VMError("PROTOCOL_ERROR", "guest agent response has unexpected payload");
    return "receive";
  }
  if (payload.byteLength !== 1 || (payload[0] !== 0 && payload[0] !== 1)) throw new VMError("PROTOCOL_ERROR", "invalid dependency restore outcome");
  return payload[0] === 1 ? "current" : "receive";
}

/** A status reply: one state byte (0 applying, 1 done, 2 failed), the entries
 * applied so far and the total, then the agent's error text for a failure. */
export function decodeRestoreStatus(payload: Uint8Array): RestoreStatus {
  if (payload.byteLength < 17 || payload.byteLength > 17 + 4096) throw new VMError("PROTOCOL_ERROR", "invalid restore status");
  const input = new AgentPayloadReader(payload);
  const state = input.u8();
  const applied = Number(input.u64());
  const total = Number(input.u64());
  if (!Number.isSafeInteger(applied) || !Number.isSafeInteger(total) || applied > total) throw new VMError("PROTOCOL_ERROR", "invalid restore progress");
  if (state === 2) {
    const error = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(17));
    return { state: "failed", applied, total, error };
  }
  if (payload.byteLength !== 17 || (state !== 0 && state !== 1)) throw new VMError("PROTOCOL_ERROR", "invalid restore status");
  return { state: state === 0 ? "applying" : "done", applied, total };
}
