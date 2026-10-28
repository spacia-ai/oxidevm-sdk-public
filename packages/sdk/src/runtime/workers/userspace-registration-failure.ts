import { VMError } from "../errors.js";
import { decodeIoUringCallSource, decodeUserspaceIoRegistrationPhase, type IoUringCallSource, type UserspaceIoRegistrationPhase } from "../userspace-abi.js";

export const USERSPACE_REGISTRATION_FAILURE_VERSION = 7;

const REASONS = ["caller-identity", "invalid-source", "changed-admission", "not-owner", "invalid-description",
  "poisoned", "caller-context", "finished", "missing-continuation", "invalid-continuation", "not-ready",
  "missing-task", "not-waiting", "out-of-memory", "file-description", "missing-ring",
  "published-state-changed", "private-state-shared", "metadata-shared", "resource-release", "private-state-poisoned",
  "cq-writer-missing", "cq-writer-changed", "cq-position-changed", "cq-memory", "cq-overflow", "cq-commit", "enter-state", "io-request-retention",
  "worker-links-poisoned", "worker-links-retiring", "worker-pool-poisoned", "worker-pool-retiring"] as const;

export interface UserspaceRegistrationFailure {
  readonly source: IoUringCallSource<426n | 427n>;
  readonly openFile: bigint | undefined;
  readonly peer: IoUringCallSource<426n | 427n> | undefined;
  readonly phase: UserspaceIoRegistrationPhase;
  readonly reason: (typeof REASONS)[number];
  readonly errno: number | undefined;
  readonly guestTicks: bigint;
  readonly workerPool?: bigint;
  readonly workerPoolCgroup?: bigint;
}

export function decodeUserspaceRegistrationFailure(bytes: Uint8Array): UserspaceRegistrationFailure {
  if (bytes.byteLength !== 256 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "OXRF") throw malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reasonCode = view.getUint8(113);
  const phase = decodeUserspaceIoRegistrationPhase(view.getUint8(112)), reason = REASONS[reasonCode - 1];
  const peerPresent = view.getUint8(114), errnoPresent = view.getUint8(115);
  const errno = view.getInt32(116, true), guestTicks = view.getBigUint64(104, true);
  const version = view.getUint16(4, true);
  const workerLimits = phase === "worker-limits";
  const workerPool = view.getBigUint64(232, true), workerPoolCgroup = view.getBigUint64(240, true);
  if ((version < 1 || version > USERSPACE_REGISTRATION_FAILURE_VERSION) || view.getUint16(6, true) !== 256
    || version === 1 && (view.getUint8(112) > 9 || view.getUint8(113) > 14)
    || version === 2 && view.getUint8(112) > 11
    || version === 3 && view.getUint8(112) > 13
    || version < 6 && (view.getUint8(112) > 15 || reasonCode > 21)
    || version < 7 && (view.getUint8(112) > 16 || reasonCode > 29 || workerPool !== 0n || workerPoolCgroup !== 0n)
    || phase === undefined || reason === undefined || peerPresent > 1 || errnoPresent > 1
    || (errnoPresent === 0 ? errno !== 0 : errno <= 0 || errno > 4095)
    || bytes.subarray(120, 128).some(byte => byte !== 0) || bytes.subarray(248).some(byte => byte !== 0)
    || peerPresent === 0 && bytes.subarray(128, 224).some(byte => byte !== 0)) throw malformed();
  const source = decodeIoUringCallSource(bytes.subarray(8, 104));
  const number = source.number;
  if ((number !== 426n && number !== 427n) || source.guestTicks > guestTicks
    || number === 426n && (version < 5 || phase !== "selection" && phase !== "mutex" && phase !== "handoff" && phase !== "enter-body")) throw malformed();
  if (phase === "enter-body") {
    const flags = Number(source.arguments[3] & 0xffff_ffffn), fd = source.arguments[0] & 0xffff_ffffn;
    if (version < 6 || number !== 426n || reasonCode !== 7 && reasonCode < 22
      || (flags & ~255) !== 0 || (flags & 16) !== 0 && fd >= 16n || (flags & 16) === 0 && fd >= 0x8000_0000n
      || (reasonCode >= 22 && reasonCode <= 24 ? errnoPresent !== 0 : errnoPresent !== 1)
      || reasonCode !== 23 && peerPresent !== 0) throw malformed();
  } else if (reasonCode >= 22 && (!workerLimits || reasonCode < 30)) throw malformed();
  const operation = source.arguments[1] & 0x7fff_ffffn;
  if (workerLimits && (version < 7 || number !== 427n || operation !== 19n || peerPresent !== 0)
    || reasonCode >= 30 && (!workerLimits || source.arguments[2] === 0n
      || (source.arguments[3] & 0xffff_ffffn) !== 2n
      || (reasonCode === 31 || reasonCode === 33 ? errnoPresent !== 0 : errnoPresent !== 1 || errno !== 5))
    || (reasonCode === 32 || reasonCode === 33 ? workerPool === 0n || workerPoolCgroup === 0n
      : workerPool !== 0n || workerPoolCgroup !== 0n)) throw malformed();
  if ((phase === "napi" || phase === "napi-disposal") && operation !== 27n && operation !== 28n
    || (phase === "sync-cancel" || phase === "sync-cancel-wait") && (operation !== 24n
      || source.arguments[2] === 0n || (source.arguments[3] & 0xffff_ffffn) !== 1n)
    || phase === "napi-disposal" && (operation !== 27n || source.arguments[2] === 0n
      || (source.arguments[3] & 0xffff_ffffn) !== 1n)) throw malformed();
  const primary: IoUringCallSource<426n | 427n> = { ...source, number };
  let peer: IoUringCallSource<426n | 427n> | undefined;
  if (peerPresent === 1) {
    const value = decodeIoUringCallSource(bytes.subarray(128, 224));
    if ((value.number !== 426n && value.number !== 427n) || value.guestTicks > guestTicks
      || phase === "enter-body" && value.number !== 426n) throw malformed();
    peer = { ...value, number: value.number };
  }
  const openFile = view.getBigUint64(224, true);
  return { source: primary, openFile: openFile === 0n ? undefined : openFile, peer, phase, reason, errno: errnoPresent === 1 ? errno : undefined, guestTicks,
    ...(workerPool === 0n ? {} : { workerPool, workerPoolCgroup }) };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace registration failure record is malformed");
}
