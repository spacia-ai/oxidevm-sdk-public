import { VMError } from "./errors.ts";

const PHASES = ["selection", "mutex", "admission", "buffer", "disposal", "query", "finished", "handoff", "returning", "files", "file-disposal", "napi", "napi-disposal", "sync-cancel", "sync-cancel-wait", "enter-body", "worker-limits"] as const;
export type UserspaceIoRegistrationPhase = (typeof PHASES)[number];

export function decodeUserspaceIoRegistrationPhase(code: number): UserspaceIoRegistrationPhase | undefined {
  return PHASES[code - 1];
}

export type UserspaceIoUringRegistrationWait = {
  readonly kind: "io-uring-registration";
  readonly phase: Exclude<UserspaceIoRegistrationPhase, "selection" | "finished" | "handoff" | "enter-body">;
  readonly reason: "mutex" | "turn-limit" | "cpu-quota" | "sync-cancel" | "sync-cancel-mutex";
  readonly ringOpenFileId: bigint | undefined;
  readonly admittedGuestTicks: bigint;
  readonly guestTicks: bigint;
  readonly kernelUnits: number;
};

export function decodeIoUringRegistrationWait(
  bytes: Uint8Array, view: DataView, offset: number, version: number,
): UserspaceIoUringRegistrationWait {
  const ring = view.getBigUint64(offset + 128, true), admittedGuestTicks = view.getBigUint64(offset + 136, true);
  const phase = decodeUserspaceIoRegistrationPhase(view.getUint8(offset + 192));
  const reasonId = view.getUint8(offset + 193);
  const reason = reasonId === 1 ? "mutex" : reasonId === 2 ? "turn-limit" : reasonId === 3 ? "cpu-quota"
    : reasonId === 4 ? "sync-cancel" : reasonId === 5 ? "sync-cancel-mutex" : undefined;
  const kernelUnits = view.getUint32(offset + 196, true), guestTicks = view.getBigUint64(offset + 200, true);
  const operation = view.getBigUint64(offset + 72, true) & 0x7fff_ffffn;
  const files = phase === "files" || phase === "file-disposal";
  const napi = phase === "napi" || phase === "napi-disposal";
  const sync = phase === "sync-cancel" || phase === "sync-cancel-wait";
  const workerLimits = phase === "worker-limits";
  if (phase === undefined || phase === "selection" || phase === "finished" || phase === "handoff" || phase === "enter-body"
    || files && (version < 30 || operation !== 2n && operation !== 3n)
    || workerLimits && (version < 51 || operation !== 19n)
    || napi && (version < 32 || operation !== 27n && operation !== 28n)
    || sync && (version < 33 || operation !== 24n || view.getBigUint64(offset + 80, true) === 0n
      || (view.getBigUint64(offset + 88, true) & 0xffff_ffffn) !== 1n)
    || phase === "napi-disposal" && (operation !== 27n || view.getBigUint64(offset + 80, true) === 0n
      || (view.getBigUint64(offset + 88, true) & 0xffff_ffffn) !== 1n)
    || reason === undefined || kernelUnits > 128 || guestTicks < admittedGuestTicks
    || guestTicks - admittedGuestTicks < BigInt(kernelUnits) || ring === 0xffff_ffff_ffff_ffffn
    || reason === "mutex" && (phase !== "mutex" || kernelUnits !== 0)
    || reason === "sync-cancel" && (phase !== "sync-cancel-wait" || kernelUnits === 0)
    || reason === "sync-cancel-mutex" && phase !== "sync-cancel-wait"
    || reason === "turn-limit" && (kernelUnits !== 128 || phase !== "buffer" && phase !== "disposal" && phase !== "query" && !files && !sync && !workerLimits && phase !== "napi-disposal")
    || reason === "cpu-quota" && phase === "mutex"
    || view.getBigUint64(offset + 56, true) !== 427n
    || (view.getBigUint64(offset + 64, true) & 0xffff_ffffn) === 0xffff_ffffn
    || bytes.subarray(offset + 194, offset + 196).some(byte => byte !== 0)
    || bytes.subarray(offset + 208, offset + 272).some(byte => byte !== 0)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace registration turn trace is malformed");
  }
  return { kind: "io-uring-registration", phase, reason, ringOpenFileId: ring === 0n ? undefined : ring,
    admittedGuestTicks, guestTicks, kernelUnits };
}

export type UserspaceIoUringRegistrationDrain = {
  readonly kind: "io-uring-registration-drain";
  readonly purpose: "exec" | "exit-group" | "seccomp-process-kill";
  readonly pendingRegistrations: number;
  readonly pendingRequests: bigint;
};

export function decodeIoUringRegistrationDrain(
  bytes: Uint8Array, view: DataView, offset: number,
): UserspaceIoUringRegistrationDrain {
  const count = view.getBigUint64(offset + 128, true);
  const id = view.getBigUint64(offset + 136, true);
  const purpose = id === 1n ? "exec" : id === 2n ? "exit-group" : id === 3n ? "seccomp-process-kill" : undefined;
  const number = view.getBigUint64(offset + 56, true);
  if (purpose === undefined || count === 0n || count > 4096n
    || purpose === "exec" && number !== 59n && number !== 322n
    || purpose === "exit-group" && number !== 231n
    || bytes.subarray(offset + 200, offset + 272).some(byte => byte !== 0)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace registration drain trace is malformed");
  }
  return { kind: "io-uring-registration-drain", purpose, pendingRegistrations: Number(count),
    pendingRequests: view.getBigUint64(offset + 192, true) };
}
