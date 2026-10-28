import { VMError } from "./errors.js";
import {decodeSnapshotRef,type SnapshotInfo,type SnapshotRef} from "./protocol/snapshots.js";
import {SHIPPED_NAME} from "./protocol/snapshot-archive.js";
import type {ManagedBoot} from "./protocol/storage.js";
import type { ManagedBootReason, ManagedResume, ManagedStart, ShippedSkipReason, StartProgress } from "./snapshot-types.js";
import {decodeShippedInstallIdentity,sameShippedIdentity,type ShippedInstallIdentity,type ShippedSource} from "./protocol/shipped-source.js";
import type {InitialStartState} from "./protocol/initial-start.js";

const SHIPPED_REASONS = ["untrusted", "signature-invalid", "newer", "older", "incompatible", "damaged", "unavailable"] as const;

/** What a successful resume brought back, besides its restore point. */
export type ResumedSession = Omit<Extract<ManagedStart, { readonly kind: "resumed" }>, "kind" | "snapshot" | "skipped">;

/** The operations a managed start uses; each runtime owns its native boot and restore. */
export interface ManagedStartPort {
  initialStart():Promise<InitialStartState>;
  retireInitialStart():Promise<void>;
  /** The restore points a resume of `resume` tries, in order. */
  candidates(resume: "latest" | SnapshotRef): Promise<readonly SnapshotInfo[]>;
  /** Whether this workspace holds any restore point. */
  hasRestorePoints(): Promise<boolean>;
  /** Restores `snapshot` and brings its guest up to date; throws when it cannot. */
  resume(snapshot: SnapshotInfo,initialStart?:ShippedInstallIdentity): Promise<ResumedSession>;
  /** Boots the image cold from the disk generation `boot` selects. */
  coldBoot(boot: ManagedBoot): Promise<void>;
  /** Installs the shipped restore point the page asked for; absent when it asked for none. */
  readonly shipped?:
    | {readonly kind:"listed";install():Promise<SnapshotInfo>}
    | {readonly kind:"reference";readonly source:ShippedInstallIdentity;install():Promise<SnapshotInfo>};
}

/** Classify and record pending intent before a mode creates managed image bookkeeping. */
export async function prepareInitialStart(
  source:ShippedSource|undefined,
  resume:ManagedResume,
  port:{state():Promise<InitialStartState>;begin(source:ShippedInstallIdentity):Promise<InitialStartState>},
):Promise<InitialStartState> {
  if(resume!=="latest")return {kind:"existing"};
  const state=await port.state();
  if(source?.kind!=="reference"||state.kind==="existing")return state;
  const identity=referenceIdentity(source);
  if(state.kind==="pending"&&!sameShippedIdentity(state.source,identity))throw new VMError("INVALID_ARGUMENT","A different prepared start is pending",{reason:"shipped-incompatible"});
  return port.begin(identity);
}

export function referenceIdentity(source:Extract<ShippedSource,{kind:"reference"}>):ShippedInstallIdentity {
  return decodeShippedInstallIdentity({mode:source.reference.mode,snapshotManifestSHA256:source.reference.manifestSHA256,imageManifestSHA256:source.reference.imageManifestSHA256});
}

/**
 * Starts a managed VM as `resume` asks. A resume tries its candidates in order: one that cannot
 * be read or whose restore finds damage gives way to the next, older one; any other reason it
 * cannot resume stops the search. The shipped restore point the page asked for opens only on a
 * first visit, when the workspace holds no restore point of its own: a learner with saves keeps
 * their own files. Whenever nothing resumes, Linux boots cold from the live disk, the one the user
 * last had, and the result names the restore point it skipped and why the shipped one did not
 * open.
 */
export async function startManaged(port: ManagedStartPort, resume: ManagedResume): Promise<ManagedStart> {
  if (resume === "none" || resume === "pre-resume" || resume === "fresh-image" || resume === "update-image") {
    await port.coldBoot(resume === "none" ? "live" : resume);
    await port.retireInitialStart();
    return { kind: "booted", reason: resume === "none" || resume === "pre-resume" ? "restart" : resume };
  }
  const initial=resume==="latest"?await port.initialStart():{kind:"existing" as const};
  if(resume==="latest"&&initial.kind!=="existing"&&port.shipped?.kind==="reference") {
    if(initial.kind==="pending"&&!sameShippedIdentity(initial.source,port.shipped.source))throw new VMError("INVALID_ARGUMENT","A different prepared start is pending",{reason:"shipped-incompatible"});
    const snapshot=await port.shipped.install();
    const session=await port.resume(snapshot,port.shipped.source);
    return {kind:"resumed",snapshot,...session};
  }
  if(initial.kind==="pending")throw new VMError("INVALID_ARGUMENT","An interrupted prepared start requires its original source",{reason:"shipped-incompatible"});
  const candidates = await port.candidates(resume);
  let skipped: SnapshotInfo | undefined;
  let reason: ManagedBootReason = "damaged";
  if (candidates.length === 0) reason = (await port.hasRestorePoints()) ? "no-save" : "first-start";
  for (const candidate of candidates) {
    if (candidate.resumable !== true) {
      skipped ??= candidate;
      if (candidate.resumable === "corrupt") continue;
      reason = "incompatible";
      break;
    }
    let session:ResumedSession;
    try {
      session = await port.resume(candidate);
    } catch (error) {
      if (error instanceof VMError && error.code === "ABORTED") throw error;
      skipped ??= candidate;
      reason = failureReason(error);
      if (reason !== "damaged") break;
      continue;
    }
    if(resume!=="latest")await port.retireInitialStart();
    return { kind: "resumed", snapshot: candidate, ...session, ...(skipped === undefined ? {} : { skipped }) };
  }
  const firstVisit = resume === "latest" && initial.kind==="empty" && reason === "first-start";
  const source=port.shipped;
  const shipped = firstVisit && source?.kind==="listed" ? await openShipped(port, () => source.install()) : undefined;
  if (shipped?.kind === "resumed") {
    return { kind: "resumed", snapshot: shipped.snapshot, ...shipped.session, ...(skipped === undefined ? {} : { skipped }) };
  }
  await port.coldBoot("live");
  if(resume!=="latest")await port.retireInitialStart();
  return {
    kind: "booted",
    reason,
    ...(skipped === undefined ? {} : { skipped }),
    ...(shipped === undefined ? {} : { shipped: { reason: shipped.reason } }),
  };
}

/** Installs and resumes the shipped restore point, or says why it did not open. */
async function openShipped(
  port: ManagedStartPort,
  install: () => Promise<SnapshotInfo>,
): Promise<
  | { readonly kind: "resumed"; readonly snapshot: SnapshotInfo; readonly session: ResumedSession }
  | { readonly kind: "skipped"; readonly reason: ShippedSkipReason }
> {
  let snapshot: SnapshotInfo;
  try {
    snapshot = await install();
  } catch (error) {
    if (error instanceof VMError && error.code === "ABORTED") throw error;
    return { kind: "skipped", reason: installFailure(error) };
  }
  try {
    return { kind: "resumed", snapshot, session: await port.resume(snapshot) };
  } catch (error) {
    if (error instanceof VMError && error.code === "ABORTED") throw error;
    const failure = failureReason(error);
    return { kind: "skipped", reason: failure === "agent-unavailable" || failure === "no-space" ? failure : "restore-failed" };
  }
}

function installFailure(error: unknown): ShippedSkipReason {
  if (!(error instanceof VMError)) return "unavailable";
  if (error.code === "QUOTA_EXCEEDED") return "no-space";
  const reason = error.detail?.["reason"];
  return SHIPPED_REASONS.find((candidate) => reason === `shipped-${candidate}`) ?? "unavailable";
}

function failureReason(error: unknown): ManagedBootReason {
  if (!(error instanceof VMError)) return "restore-failed";
  if (error.code === "QUOTA_EXCEEDED") return "no-space";
  const reason = error.detail?.["reason"];
  if (reason === "agent-unavailable") return "agent-unavailable";
  return reason === "snapshot-damaged" ? "damaged" : "restore-failed";
}

/**
 * Reports steps to the page's `onProgress`, each in its own microtask so a listener that throws
 * cannot fail the start; undefined when the page does not listen.
 */
export function progressReport(onProgress: ((progress: StartProgress) => void) | undefined): ((progress: StartProgress) => void) | undefined {
  if (onProgress === undefined) return undefined;
  // Untyped callers may pass anything.
  const listener: unknown = onProgress;
  if (typeof listener !== "function") throw new VMError("INVALID_ARGUMENT", "onProgress must be a function");
  return (progress) => {
    queueMicrotask(() => {
      onProgress(progress);
    });
  };
}

/** The shipped restore point a boot asks for, from a caller that may pass anything. */
export function decodeShippedName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHIPPED_NAME.test(value)) {
    throw new VMError("INVALID_ARGUMENT", "a shipped restore point is named as its profile lists it");
  }
  return value;
}

/** Where a managed boot starts; anything but the documented forms is refused. */
export function decodeManagedResume(value: unknown): ManagedResume {
  return value === "latest" || value === "none" || value === "pre-resume" || value === "fresh-image" || value === "update-image"
    ? value
    : decodeSnapshotRef(value);
}

