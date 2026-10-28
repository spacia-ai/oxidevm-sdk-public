import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";

export type WorkspaceCapture =
  | { readonly kind: "begin"; readonly transfer: number; readonly format: "snapshot" | "delta" }
  | { readonly kind: "read"; readonly transfer: number; readonly offset: number }
  | { readonly kind: "finish" | "abort"; readonly transfer: number };

export type CapturePhase = "baseline" | "scan" | "plan" | "rescan";
export type CaptureCounts = Record<CapturePhase, number>;
export interface WorkspaceCaptureProgress { readonly phase: CapturePhase; readonly entries: number }

export function emptyCaptureCounts(): CaptureCounts { return { baseline: 0, scan: 0, plan: 0, rescan: 0 }; }

function checkedProgress(value: unknown): WorkspaceCaptureProgress {
  const input = record(value, "capture progress");
  exactKeys(input, ["phase", "entries"]);
  const phase = input["phase"];
  if (phase !== "baseline" && phase !== "scan" && phase !== "plan" && phase !== "rescan") {
    throw new VMError("PROTOCOL_ERROR", "Invalid capture progress phase");
  }
  return { phase, entries: integer(input["entries"], "capture completed entries", 0, 2_000_000) };
}

export function encodeWorkspaceCaptureProgress(value: unknown): Uint8Array<ArrayBuffer> {
  const input = checkedProgress(value);
  return new AgentPayloadWriter(12).u8(1).u8(0).u8({ baseline: 0, scan: 1, plan: 2, rescan: 3 }[input.phase])
    .u8(0).u64(BigInt(input.entries)).finish();
}

export function decodeWorkspaceCaptureProgress(bytes: Uint8Array): WorkspaceCaptureProgress {
  const input = new AgentPayloadReader(bytes);
  if (input.u8() !== 1 || input.u8() !== 0) throw new VMError("PROTOCOL_ERROR", "Unsupported capture progress schema");
  const phase = ["baseline", "scan", "plan", "rescan"][input.u8()];
  if (input.u8() !== 0) throw new VMError("PROTOCOL_ERROR", "Invalid capture progress flags");
  const entries = Number(input.u64());
  input.finish();
  return checkedProgress({ phase, entries });
}

function checked(value: unknown, version: number): WorkspaceCapture {
  if (version !== 7) throw new VMError("PROTOCOL_ERROR", "Streamed capture requires guest seven");
  const input = record(value, "workspace capture");
  const transfer = integer(input["transfer"], "capture transfer", 1, 0xffff_ffff);
  const kind = input["kind"];
  switch (kind) {
    case "begin": {
      exactKeys(input, ["kind", "transfer", "format"]);
      const format = input["format"];
      if (format !== "snapshot" && format !== "delta") throw new VMError("PROTOCOL_ERROR", "Invalid capture format");
      return { kind, transfer, format };
    }
    case "read":
      exactKeys(input, ["kind", "transfer", "offset"]);
      return { kind, transfer, offset: integer(input["offset"], "capture offset", 0, 1024 ** 4) };
    case "finish": case "abort":
      exactKeys(input, ["kind", "transfer"]);
      return { kind, transfer };
    default: throw new VMError("PROTOCOL_ERROR", "Invalid capture operation");
  }
}

export function encodeWorkspaceCapture(value: unknown, version: number): Uint8Array<ArrayBuffer> {
  const input = checked(value, version);
  const output = new AgentPayloadWriter(13);
  output.u8({ begin: 1, read: 2, finish: 3, abort: 4 }[input.kind]).u32(input.transfer);
  if (input.kind === "begin") output.u8(input.format === "snapshot" ? 0 : 1);
  if (input.kind === "read") output.u64(BigInt(input.offset));
  return output.finish();
}

export function decodeWorkspaceCapture(bytes: Uint8Array, version: number): WorkspaceCapture {
  const input = new AgentPayloadReader(bytes);
  const kind = input.u8();
  const transfer = input.u32();
  let value: unknown;
  switch (kind) {
    case 1: {
      const format = input.u8();
      value = { kind: "begin", transfer, format: format === 0 ? "snapshot" : format === 1 ? "delta" : undefined }; break;
    }
    case 2: value = { kind: "read", transfer, offset: Number(input.u64()) }; break;
    case 3: value = { kind: "finish", transfer }; break;
    case 4: value = { kind: "abort", transfer }; break;
    default: throw new VMError("PROTOCOL_ERROR", "Invalid capture operation");
  }
  input.finish();
  return checked(value, version);
}
