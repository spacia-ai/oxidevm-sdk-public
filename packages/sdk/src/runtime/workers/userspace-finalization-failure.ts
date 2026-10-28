import { decodeFinalizationSource as decodeSource, finalizationSourceDetail as sourceDetail, type FinalizationSource as Source } from "./userspace-finalization-source.ts";
import { VMError } from "../errors.ts";
import { decodeTaskFilterFinalizationFailure, taskFilterFinalizationFailureDetail, type UserspaceTaskFilterFinalizationFailure } from "./userspace-task-filter-finalization-failure.ts";
import { decodePoolFinalizationFailure, poolFinalizationFailureDetail, type UserspacePoolFinalizationFailure } from "./userspace-pool-finalization-failure.ts";
import { decodeRingFinalizationProgress, type RingFinalizationProgress } from "../userspace-ring-finalization-progress.ts";
import { readNapiRetirementFields } from "../userspace-napi-retirement.ts";
import { readRegionRetirementFields } from "../userspace-region-retirement.ts";
import { readPersonalityRetirementFields } from "../userspace-personality-retirement.ts";
import { filterRetirementDetail, readFilterRetirementFields } from "../userspace-filter-retirement.ts";
import { readWorkerBindingFields } from "../userspace-worker-binding-retirement.ts";

export type UserspaceFinalizationFailure = UserspacePoolFinalizationFailure | UserspaceTaskFilterFinalizationFailure | {
  readonly kind?: never; readonly errno: number; readonly guestTicks: bigint;
} & (
  | { readonly stage: "selection"; readonly identity?: never; readonly progress?: never }
  | { readonly stage: "resource" | "ownership";
      readonly identity: { readonly ringObjectId: bigint; readonly ringOpenFileId: bigint; readonly cpuCgroupId: bigint; readonly source: Source };
      readonly progress: RingFinalizationProgress }
);

/** Read the canonical stopped owner even when the bounded execution trace is disabled. */
export function decodeUserspaceFinalizationFailure(bytes: Uint8Array): UserspaceFinalizationFailure {
  if (bytes.byteLength !== 256 && bytes.byteLength !== 320 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "OXFF") throw malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const guestTicks = view.getBigUint64(8, true), stage = view.getUint8(16), errno = view.getInt32(20, true), version = view.getUint16(4, true);
  if (!Number.isInteger(version) || version < 1 || version > 10 || bytes.byteLength !== (version >= 9 ? 320 : 256)
    || view.getUint16(6, true) !== bytes.byteLength || view.getUint8(19) !== 0
    || errno <= 0 || errno > 4095) throw malformed();
  if (version >= 9 && stage >= 4 && stage <= 7) return decodePoolFinalizationFailure(bytes, view, guestTicks, stage, errno);
  if (version >= 10 && stage >= 8 && stage <= 11) return decodeTaskFilterFinalizationFailure(bytes, view, guestTicks, stage, errno);
  if (version >= 9 && nonzero(bytes, 256, 320)) throw malformed();
  if (stage === 1 && view.getUint8(17) === 0 && view.getUint8(18) === 0 && !nonzero(bytes, 24, 256)) {
    return { stage: "selection", errno, guestTicks };
  }
  const progressKind = view.getUint8(184);
  if ((stage !== 2 && stage !== 3) || view.getUint8(17) !== 1 || view.getUint8(18) !== 1
    || progressKind === 4 && version < 2 || progressKind === 5 && version < 3 || progressKind === 6 && version < 4 || progressKind === 7 && version < 5 || progressKind === 8 && version < 6 || progressKind === 9 && version < 7 || progressKind === 10 && version < 8 || view.getUint8(187) !== 0
    || progressKind !== 4 && progressKind !== 5 && view.getUint16(190, true) !== 0
    || (progressKind === 6 || progressKind === 7 || progressKind === 8 || progressKind === 9 || progressKind === 10) && nonzero(bytes, 188, 208)
    || progressKind !== 6 && progressKind !== 7 && progressKind !== 8 && progressKind !== 9 && progressKind !== 10 && nonzero(bytes, 236, 240)
    || progressKind !== 7 && progressKind !== 9 && progressKind !== 10 && nonzero(bytes, 248, 256)) throw malformed();
  const ringObjectId = view.getBigUint64(24, true), ringOpenFileId = view.getBigUint64(32, true), cpuCgroupId = view.getBigUint64(40, true);
  if (!identity(ringObjectId) || !identity(ringOpenFileId) || !identity(cpuCgroupId)) throw malformed();
  const source = decodeSource(bytes, view, guestTicks);
  const fieldsOnly = progressKind === 5 || progressKind === 6 || progressKind === 7 || progressKind === 8 || progressKind === 9 || progressKind === 10;
  const progress = decodeRingFinalizationProgress({ kind: progressKind, phase: view.getUint8(185), resource: view.getUint8(186),
    origin: progressKind === 5 ? 0n : view.getBigUint64(192, true),
    index: progressKind === 5 ? 0 : progressKind === 4 ? view.getUint32(188, true) : view.getUint16(188, true),
    pinsBefore: progressKind === 5 ? 0n : view.getBigUint64(200, true),
    metadataReferencesBefore: fieldsOnly ? 0n : view.getBigUint64(208, true), tag: fieldsOnly ? 0n : view.getBigUint64(216, true),
    ringsPages: fieldsOnly ? 0 : view.getUint32(224, true), sqePages: fieldsOnly ? 0 : view.getUint32(228, true),
    metadataPages: fieldsOnly ? 0 : view.getUint32(232, true), lockedPagesBefore: progressKind === 6 || progressKind === 7 || progressKind === 8 || progressKind === 9 || progressKind === 10 ? 0n : view.getBigUint64(240, true),
    ...(progressKind === 5 ? { provided: {
      groupId: view.getUint16(188, true), firstId: view.getUint16(190, true),
      metadataAllocationId: view.getBigUint64(192, true), allocationCgroupId: view.getBigUint64(200, true),
      address: view.getBigUint64(208, true), length: view.getUint32(216, true), count: view.getUint32(220, true),
      runsBefore: view.getUint32(224, true), buffersBefore: view.getUint32(228, true), groupsBefore: view.getUint32(232, true),
    } } : {}),
    ...(progressKind === 6 ? { napi: readNapiRetirementFields(view, 208) } : {}),
    ...(progressKind === 7 ? { region: readRegionRetirementFields(view, 208) } : {}),
    ...(progressKind === 8 ? { personality: readPersonalityRetirementFields(view, 208) } : {}),
    ...(progressKind === 9 ? { filter: readFilterRetirementFields(view, 208) } : {}),
    ...(progressKind === 10 ? { workerBindings: readWorkerBindingFields(view, 208) } : {}),
  });
  return { stage: stage === 2 ? "resource" : "ownership", errno, guestTicks,
    identity: { ringObjectId, ringOpenFileId, cpuCgroupId, source }, progress };
}


export function finalizationFailureDetail(failure: UserspaceFinalizationFailure) {
  if (failure.kind === "task-filters") return taskFilterFinalizationFailureDetail(failure);
  if (failure.kind === "pool") return poolFinalizationFailureDetail(failure);
  const base = { reason: "io-finalization-failure", stage: failure.stage, errno: failure.errno, guestTicks: failure.guestTicks.toString() };
  if (failure.identity === undefined) return base;
  const { ringObjectId, ringOpenFileId, cpuCgroupId, source } = failure.identity;
  return { ...base, ringObjectId: ringObjectId.toString(), ringOpenFileId: ringOpenFileId.toString(), cpuCgroupId: cpuCgroupId.toString(),
    source: sourceDetail(source), progress: progressDetail(failure.progress) };
}


function progressDetail(progress: RingFinalizationProgress) {
  if (progress.kind === "worker-bindings") return { ...progress,
    poolAllocationId: progress.poolAllocationId.toString(), poolAllocationCgroupId: progress.poolAllocationCgroupId.toString(),
    ...(progress.metadata === undefined ? {} : { metadata: { allocationId: progress.metadata.allocationId.toString(),
      allocationCgroupId: progress.metadata.allocationCgroupId.toString(), references: progress.metadata.references.toString() } }) };

  if (progress.kind === "filters") {
    return filterRetirementDetail(progress);
  }
  if (progress.kind === "personalities") {
    if (progress.phase === "personality-owner" || progress.phase === "personality-free-range") return progress;
    if (progress.phase === "personality-metadata") return { ...progress,
      allocationId: progress.allocationId.toString(), allocationCgroupId: progress.allocationCgroupId.toString() };
    const credentialId = progress.credentialId.toString();
    if (progress.phase === "personality-snapshot-metadata") return { ...progress, credentialId,
      allocationId: progress.allocationId.toString(), allocationCgroupId: progress.allocationCgroupId.toString() };
    return { ...progress, credentialId };
  }
  if (progress.kind === "region") {
    if (progress.phase === "region-owner") return progress;
    if (progress.phase === "region-unaccount") return { ...progress, lockedPagesBefore: progress.lockedPagesBefore.toString() };
    const allocation = { allocationId: progress.allocationId.toString(), allocationCgroupId: progress.allocationCgroupId.toString() };
    return { ...progress, ...allocation, ...(progress.phase === "region-kernel-page"
      ? { backingId: progress.backingId.toString(), offset: progress.offset.toString() } : {}) };
  }
  if (progress.kind === "napi" && progress.phase === "napi-id") return { ...progress, expiryJiffies: progress.expiryJiffies.toString() };
  if (progress.kind === "napi" && progress.phase === "napi-metadata") return { ...progress,
    metadataAllocationId: progress.metadataAllocationId.toString(), allocationCgroupId: progress.allocationCgroupId.toString() };
  if (progress.kind === "provided-buffers") return { ...progress,
    metadataAllocationId: progress.metadataAllocationId.toString(), allocationCgroupId: progress.allocationCgroupId.toString(),
    ...(progress.phase === "provided-run" ? { address: progress.address.toString() } : {}) };
  if (progress.kind === "buffers") return { ...progress, pinsBefore: progress.pinsBefore.toString(),
    metadataReferencesBefore: progress.metadataReferencesBefore.toString(), tag: progress.tag.toString(),
    ...(progress.resource === undefined ? {} : { resource: { ...progress.resource, origin: progress.resource.origin.toString() } }) };
  if (progress.kind === "files" && progress.phase === "file-descriptor") return { ...progress, openFileId: progress.openFileId.toString() };
  if (progress.kind === "queues" && progress.phase === "queue-unaccount") return { ...progress, lockedPagesBefore: progress.lockedPagesBefore.toString() };
  return progress;
}

function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function nonzero(bytes: Uint8Array, start: number, end: number): boolean { return bytes.subarray(start, end).some(value => value !== 0); }
function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace ring finalization failure is malformed"); }
