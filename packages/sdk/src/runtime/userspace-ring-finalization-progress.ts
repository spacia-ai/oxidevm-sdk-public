import { VMError } from "./errors.ts";
import { decodeWorkerBindingRetirement, type WorkerBindingRetirement, type WorkerBindingFields } from "./userspace-worker-binding-retirement.ts";
import { decodeFilterRetirement, type FilterRetirement, type FilterRetirementFields } from "./userspace-filter-retirement.ts";
import { decodeBufferDisposalPhase, type BufferRetirement } from "./userspace-buffer-retirement-trace.ts";
import { decodeProvidedBufferRetirement, type ProvidedBufferRetirement, type ProvidedBufferRetirementFields } from "./userspace-provided-buffer-retirement.ts";
import { decodeNapiRetirement, type NapiRetirement, type NapiRetirementFields } from "./userspace-napi-retirement.ts";
import { decodeRegionRetirement, type RegionRetirement, type RegionRetirementFields } from "./userspace-region-retirement.ts";
import { decodePersonalityRetirement, type PersonalityRetirement, type PersonalityRetirementFields } from "./userspace-personality-retirement.ts";

type BufferProgress = Pick<BufferRetirement, "phase" | "resource" | "pinsBefore" | "metadataReferencesBefore" | "tag">;
type QueueCounts = { readonly ringsPages: number; readonly sqePages: number; readonly metadataPages: number };
export type RingFinalizationProgress =
  | WorkerBindingRetirement
  | FilterRetirement
  | PersonalityRetirement
  | RegionRetirement
  | NapiRetirement
  | ProvidedBufferRetirement
  | { readonly kind: "files"; readonly phase: "file-descriptor"; readonly slot: number; readonly openFileId: bigint;
      readonly descriptorsBefore: number; readonly metadataPagesBefore: number }
  | { readonly kind: "files"; readonly phase: "file-metadata"; readonly metadataPagesBefore: number }
  | { readonly kind: "files"; readonly phase: "file-owner" }
  | ({ readonly kind: "buffers" } & BufferProgress)
  | ({ readonly kind: "queues" } & QueueCounts & (
      { readonly phase: "queue-unaccount"; readonly lockedPagesBefore: bigint }
      | { readonly phase: "queue-rings" | "queue-sqes" | "queue-metadata" | "queue-owner" }))
  | { readonly kind: "owner" };

/** Both trace and failure records describe the same action before it commits. */
export function decodeRingFinalizationProgress(raw: {
  readonly kind: number; readonly phase: number; readonly resource: number;
  readonly origin: bigint; readonly index: number; readonly pinsBefore: bigint;
  readonly metadataReferencesBefore: bigint; readonly tag: bigint;
  readonly ringsPages: number; readonly sqePages: number; readonly metadataPages: number;
  readonly lockedPagesBefore: bigint;
  readonly provided?: ProvidedBufferRetirementFields;
  readonly napi?: NapiRetirementFields;
  readonly region?: RegionRetirementFields;
  readonly personality?: PersonalityRetirementFields;
  readonly filter?: FilterRetirementFields;
  readonly workerBindings?: WorkerBindingFields;
}): RingFinalizationProgress {
  const { origin, index, pinsBefore, metadataReferencesBefore, tag, ringsPages, sqePages, metadataPages, lockedPagesBefore } = raw;
  if (raw.kind !== 6 && raw.napi !== undefined || raw.kind !== 7 && raw.region !== undefined || raw.kind !== 8 && raw.personality !== undefined || raw.kind !== 9 && raw.filter !== undefined || raw.kind !== 10 && raw.workerBindings !== undefined) throw malformed();
  if (raw.kind === 10) {
    if (raw.resource !== 1 || origin !== 0n || index !== 0 || pinsBefore !== 0n || metadataReferencesBefore !== 0n
      || tag !== 0n || ringsPages !== 0 || sqePages !== 0 || metadataPages !== 0 || lockedPagesBefore !== 0n
      || raw.provided !== undefined || raw.workerBindings === undefined) throw malformed();
    const binding = decodeWorkerBindingRetirement(raw.phase, raw.workerBindings);
    if (binding === undefined) throw malformed();
    return binding;
  }
  if (raw.kind === 9) {
    if (raw.resource !== (raw.phase === 34 || raw.phase === 35 ? 0 : 1) || origin !== 0n || index !== 0 || pinsBefore !== 0n
      || metadataReferencesBefore !== 0n || tag !== 0n || ringsPages !== 0 || sqePages !== 0
      || metadataPages !== 0 || lockedPagesBefore !== 0n || raw.provided !== undefined || raw.filter === undefined) throw malformed();
    const filter = decodeFilterRetirement(raw.phase, raw.filter);
    if (filter === undefined) throw malformed();
    return filter;
  }
  if (raw.kind === 8) {
    if (raw.resource !== (raw.phase === 26 || raw.phase === 29 ? 0 : 1) || origin !== 0n || index !== 0 || pinsBefore !== 0n
      || metadataReferencesBefore !== 0n || tag !== 0n || ringsPages !== 0 || sqePages !== 0
      || metadataPages !== 0 || lockedPagesBefore !== 0n || raw.provided !== undefined || raw.personality === undefined) throw malformed();
    const personality = decodePersonalityRetirement(raw.phase, raw.personality);
    if (personality === undefined) throw malformed();
    return personality;
  }
  if (raw.kind === 7) {
    if (raw.resource !== (raw.phase === 22 ? 0 : 1) || origin !== 0n || index !== 0 || pinsBefore !== 0n
      || metadataReferencesBefore !== 0n || tag !== 0n || ringsPages !== 0 || sqePages !== 0
      || metadataPages !== 0 || lockedPagesBefore !== 0n || raw.provided !== undefined || raw.region === undefined) throw malformed();
    const region = decodeRegionRetirement(raw.phase, raw.region);
    if (region === undefined) throw malformed();
    return region;
  }
  if (raw.kind === 6) {
    if (raw.resource !== (raw.phase === 17 ? 0 : 1) || origin !== 0n || index !== 0 || pinsBefore !== 0n
      || metadataReferencesBefore !== 0n || tag !== 0n || ringsPages !== 0 || sqePages !== 0
      || metadataPages !== 0 || lockedPagesBefore !== 0n || raw.provided !== undefined || raw.napi === undefined) throw malformed();
    const napi = decodeNapiRetirement(raw.phase, raw.napi);
    if (napi === undefined) throw malformed();
    return napi;
  }
  if (raw.kind === 5) {
    if (raw.resource !== 1 || origin !== 0n || index !== 0 || pinsBefore !== 0n || metadataReferencesBefore !== 0n
      || tag !== 0n || ringsPages !== 0 || sqePages !== 0 || metadataPages !== 0 || lockedPagesBefore !== 0n
      || raw.provided === undefined) throw malformed();
    const provided = decodeProvidedBufferRetirement(raw.phase, raw.provided);
    if (provided === undefined) throw malformed();
    return provided;
  }
  if (raw.provided !== undefined) throw malformed();
  if (raw.kind === 4) {
    if (tag !== 0n || ringsPages !== 0 || sqePages !== 0 || metadataPages !== 0 || lockedPagesBefore !== 0n
      || pinsBefore < 0n || pinsBefore > 1_048_576n || metadataReferencesBefore < 0n || metadataReferencesBefore > 8192n) throw malformed();
    if (raw.phase === 10 && raw.resource === 1 && identity(origin) && Number.isSafeInteger(index) && index >= 0
      && index < 1_048_576 && BigInt(index) < metadataReferencesBefore * 128n
      && pinsBefore > 0n && pinsBefore <= metadataReferencesBefore * 128n) {
      return { kind: "files", phase: "file-descriptor", slot: index, openFileId: origin,
        descriptorsBefore: Number(pinsBefore), metadataPagesBefore: Number(metadataReferencesBefore) };
    }
    if (raw.resource !== 0 || origin !== 0n || index !== 0 || pinsBefore !== 0n) throw malformed();
    if (raw.phase === 11 && metadataReferencesBefore > 0n) {
      return { kind: "files", phase: "file-metadata", metadataPagesBefore: Number(metadataReferencesBefore) };
    }
    if (raw.phase === 12 && metadataReferencesBefore === 0n) return { kind: "files", phase: "file-owner" };
    throw malformed();
  }
  if (raw.kind === 1) {
    const phase = decodeBufferDisposalPhase(raw.phase), resource = raw.resource;
    if (resource > 1 || index >= 16384 || pinsBefore > 262144n || metadataReferencesBefore > 131072n
      || (resource === 0 ? origin !== 0n || index !== 0 || pinsBefore !== 0n || tag !== 0n : !identity(origin))
      || phase === "tag" || ringsPages !== 0 || sqePages !== 0 || metadataPages !== 0 || lockedPagesBefore !== 0n
      || (phase === "unaccount" || phase === "unpin") && (resource !== 1 || pinsBefore === 0n)
      || phase === "buffer-metadata" && (resource !== 1 || metadataReferencesBefore === 0n || pinsBefore !== 0n)
      || phase === "tag-metadata" && (resource !== 1 || tag === 0n || pinsBefore !== 0n)
      || (phase === "owner" || phase === "finished") && (resource !== 0 || metadataReferencesBefore !== 0n)
      || phase === "metadata-pool" && resource !== 0) throw malformed();
    return { kind: "buffers", phase, pinsBefore, metadataReferencesBefore, tag,
      ...(resource === 0 ? {} : { resource: { origin, index } }) };
  }
  if (raw.resource !== 0 || origin !== 0n || index !== 0 || pinsBefore !== 0n || metadataReferencesBefore !== 0n || tag !== 0n) throw malformed();
  if (raw.kind === 2 && ringsPages <= 1024 && sqePages <= 1024 && metadataPages <= 1024) {
    const counts = { kind: "queues" as const, ringsPages, sqePages, metadataPages };
    if (raw.phase === 5 && lockedPagesBefore > 0n && lockedPagesBefore <= 2048n) {
      return { ...counts, phase: "queue-unaccount", lockedPagesBefore };
    }
    if (lockedPagesBefore !== 0n) throw malformed();
    if (raw.phase === 6 && ringsPages !== 0 && sqePages === 0) return { ...counts, phase: "queue-rings" };
    if (raw.phase === 7 && sqePages !== 0) return { ...counts, phase: "queue-sqes" };
    if (raw.phase === 8 && ringsPages === 0 && sqePages === 0 && metadataPages !== 0) return { ...counts, phase: "queue-metadata" };
    if (raw.phase === 9 && ringsPages === 0 && sqePages === 0 && metadataPages === 0) return { ...counts, phase: "queue-owner" };
  }
  if (raw.kind === 3 && raw.phase === 0 && ringsPages === 0 && sqePages === 0 && metadataPages === 0 && lockedPagesBefore === 0n) {
    return { kind: "owner" };
  }
  throw malformed();
}

function identity(value: bigint): boolean { return value > 0n && value < 0xffff_ffff_ffff_ffffn; }
function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace ring finalization progress is malformed"); }
