import { VMError } from "../errors.js";

export interface UserspaceWorkerFailure {
  readonly pid: number;
  readonly tid: number;
  readonly work: { readonly poolId: bigint; readonly sequence: bigint } | undefined;
  readonly stage: "selection" | "enter" | "request" | "leave" | "readiness" | "idle-selection" | "idle-commit" | "admission"
    | "issuer-selection" | "issuer-operation" | "issuer-publication" | "issuer-notification" | "issuer-retirement";
  readonly errno: number;
  readonly guestTicks: bigint;
}

export function decodeUserspaceWorkerFailure(bytes: Uint8Array): UserspaceWorkerFailure {
  if (bytes.byteLength !== 64 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "OXWF") throw malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pid = view.getUint32(8, true), tid = view.getUint32(12, true);
  const poolId = view.getBigUint64(16, true), sequence = view.getBigUint64(24, true);
  const errno = view.getInt32(32, true), stage = view.getUint8(36);
  const version = view.getUint16(4, true);
  if ((version !== 1 && version !== 2 && version !== 3 && version !== 4) || view.getUint16(6, true) !== 64
    || pid === 0 || tid === 0 || (poolId === 0n) !== (sequence === 0n)
    || errno <= 0 || errno > 4095 || stage < 1 || stage > (version === 4 ? 13 : version === 3 ? 8 : version === 2 ? 5 : 4)
    || (version < 3 ? stage !== 1 && poolId === 0n
      : (stage === 3 || stage === 5) && poolId === 0n || (stage === 6 || stage === 7) && poolId !== 0n)
    || stage >= 10 && poolId === 0n
    || bytes.subarray(37, 40).some((byte) => byte !== 0) || bytes.subarray(48).some((byte) => byte !== 0)) throw malformed();
  return { pid, tid, work: poolId === 0n ? undefined : { poolId, sequence },
    stage: decodeStage(stage),
    errno, guestTicks: view.getBigUint64(40, true) };
}

function decodeStage(stage: number): UserspaceWorkerFailure["stage"] {
  switch (stage) {
    case 1: return "selection";
    case 2: return "enter";
    case 3: return "request";
    case 4: return "leave";
    case 5: return "readiness";
    case 6: return "idle-selection";
    case 7: return "idle-commit";
    case 8: return "admission";
    case 9: return "issuer-selection";
    case 10: return "issuer-operation";
    case 11: return "issuer-publication";
    case 12: return "issuer-notification";
    case 13: return "issuer-retirement";
    default: throw malformed();
  }
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace worker failure record is malformed");
}
