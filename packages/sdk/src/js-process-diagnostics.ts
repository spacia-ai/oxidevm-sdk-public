import type { UserspaceVM } from "./contracts.js";
import { readOwnedJSProcessTrace, watchOwnedAccelerationNotices } from "./vm-adapter.js";
import type { AccelerationNotice } from "./runtime/js-process/late-failure.js";
import { decodeWatchOptions } from "./runtime/listening-ports.js";
import { VMError } from "./runtime/errors.js";
import { Reader, protocol } from "./runtime/js-process/codec.js";
import { decodeProcessId, type ProcessId } from "./values.js";
import { integer } from "./runtime/decode.js";
import type { NativeProcessProfile } from "./runtime/userspace-command-abi.js";
import { readNativeRoots } from "./runtime/userspace-command-abi.js";
import { lateFailureDetail, lateFailureKind, type LateFailureKind } from "./runtime/js-process/late-failure.js";

export interface JSProcessTraceEvent {
  readonly ordinal: bigint; readonly generation: bigint; readonly incarnationId: bigint; readonly requestId: bigint; readonly pid: ProcessId; readonly tid: number;
  /** Linux x86-64 syscall number, or a closed bridge service tag. No instruction address exists. */
  readonly operation: { readonly kind: "syscall"; readonly number: number } | { readonly kind: "realpath" | "path-info" | "info" | "umask" | "path-search" | "poll-pipes" | "spawn" | "cancel" | "prepare-thread" | "prepare-thread-eval" | "start-thread" | "stop-thread" | "wait-thread" | "reap-thread" };
  readonly transition: "admitted" | "completed" | "retired"; readonly errno: number | null;
}
/** Rust's closed placement reasons by code (`NativeAdmissionRejection`); numbers never move. */
const rejectionCodes = [
  [1, "unsupported-security"], [2, "unsupported-filesystem"], [3, "unsupported-cgroup"], [4, "mount-namespace"], [5, "pid-namespace"],
  [6, "uts-namespace"], [7, "ipc-namespace"], [8, "net-namespace"], [9, "cgroup-namespace"], [10, "user-namespace"],
  [11, "unsupported-invocation"], [12, "unsupported-environment"], [13, "entry-unavailable"], [14, "entry-outside-workspace"],
  [15, "profile-unavailable"], [16, "profile-invalid"], [17, "dependency-unavailable"], [18, "dependency-escape"],
  [19, "runtime-unavailable"], [20, "runtime-hash-mismatch"], [21, "host-unavailable"], [22, "host-hash-mismatch"],
  [23, "addon-unavailable"], [24, "addon-hash-mismatch"], [25, "library-unavailable"], [26, "library-hash-mismatch"],
  [27, "dependency-metadata-invalid"], [28, "dependency-closure-mismatch"], [29, "native-promise-predicate-unavailable"],
  [30, "native-error-predicate-unavailable"], [31, "native-runtime-not-qualified"], [32, "host-untrusted"],
  [33, "root-capture-limit"], [34, "root-capture-unsupported"], [35, "addon-unqualified"], [36, "command-capacity"],
  [37, "remembered-failure"], [38, "placement-override"],
  [39, "image-code-unavailable"], [40, "image-code-untrusted"],
] as const;
export type AccelerationRejectionReason = typeof rejectionCodes[number][1];
const rejectionReasons: ReadonlyMap<number, AccelerationRejectionReason> = new Map(rejectionCodes);
export type JSProcessPlacementEvent = {
  readonly ordinal: bigint; readonly pid: ProcessId; readonly parentPid: ProcessId | null; readonly entry: string | null; readonly tid: number; readonly addressSpaceId: bigint;
  readonly runtime: "node" | "bun"; readonly profile: NativeProcessProfile["identity"] | null;
  /** Present in trace version 16 and later; content identity is available for immutable image packages. */
  readonly codeRoots?: readonly { readonly kind: "dependencies" | "store" | "image"; readonly path: string; readonly contentSHA256: string | null }[];
} & (
  { readonly placement: "linux"; readonly reason: AccelerationRejectionReason; readonly environment: AccelerationEnvironmentRejection | null }
  | { readonly placement: "browser"; readonly generation: bigint; readonly incarnationId: bigint; readonly dependencyGeneration: bigint; readonly basis: NativeProcessProfile["basis"] }
);
const environmentCategories = ["unsupported-variable", "malformed-variable", "unsupported-options", "relative-search-path", "search-path-escape", "search-path-unavailable", "invalid-search-path", "duplicate-variable"] as const;
export interface AccelerationEnvironmentRejection {
  readonly variable: string;
  readonly category: typeof environmentCategories[number];
}
/** ADR 0026: a program that started on the fast path and stopped on a limitation; Rust
 * remembered it, so its next run uses full Linux. */
export interface JSProcessLateFailureEvent {
  readonly ordinal: bigint; readonly pid: ProcessId; readonly session: ProcessId | null;
  readonly generation: bigint; readonly incarnationId: bigint; readonly kind: LateFailureKind; readonly detail: string;
}
export interface JSProcessTrace {
  /** All three lists share one bounded ring and monotonic ordinal sequence. */
  readonly dropped: bigint;
  readonly events: readonly JSProcessTraceEvent[];
  readonly placements: readonly JSProcessPlacementEvent[];
  readonly failures: readonly JSProcessLateFailureEvent[];
}
export async function configureJSProcessTrace(vm: UserspaceVM, capacity: number): Promise<void> {
  await readOwnedJSProcessTrace(vm, integer(capacity, "JS trace capacity", 0, 4096));
}
export type { AccelerationNotice } from "./runtime/js-process/late-failure.js";
/** ADR 0026: calls `listener` with each late fast-path failure: a program that started on the
 * fast path and stopped on a limitation. The VM has already remembered the program, so its next
 * run uses full Linux. Resolves when `options.signal` aborts or the VM ends; fails with
 * FEATURE_NOT_AVAILABLE when the VM runs without command acceleration. */
export async function watchAccelerationNotices(vm: UserspaceVM, listener: (notice: AccelerationNotice) => void, options: { readonly signal: AbortSignal }): Promise<void> {
  if (typeof listener !== "function") throw new VMError("INVALID_ARGUMENT", "watchAccelerationNotices needs a listener function");
  const { signal } = decodeWatchOptions(options, "watchAccelerationNotices");
  return watchOwnedAccelerationNotices(vm, listener, signal);
}
export async function readJSProcessTrace(vm: UserspaceVM): Promise<JSProcessTrace> {
  return decodeJSProcessTrace(await readOwnedJSProcessTrace(vm));
}
export function decodeJSProcessTrace(bytes: Uint8Array): JSProcessTrace {
  if (bytes.byteLength > 32 * 1024 ** 2) protocol("JS trace exceeds byte capacity");
  const r = new Reader(bytes);
  if (new TextDecoder().decode(r.raw(4)) !== "OXJT") protocol("JS trace magic mismatch");
  const version = r.u32();
  if (version !== 15 && version !== 16) protocol("JS trace version mismatch");
  const dropped = r.u64(), count = r.u32(), placementCount = r.u32(), failureCount = r.u32(), events: JSProcessTraceEvent[] = [], placements: JSProcessPlacementEvent[] = [];
  if (count + placementCount + failureCount > 4096) protocol("JS trace exceeds capacity");
  const ordinals = new Set<bigint>();
  let previous = 0n;
  for (let index = 0; index < count; index++) {
    const ordinal = r.u64(), generation = r.u64(), incarnationId = r.u64(), requestId = r.u64(), pid = decodeProcessId(r.u32()), tid = integer(r.u32(), "JS native task", 1, 0x7fff_ffff), number = r.u32(), transition = r.u32(), errno = r.u32();
    if (ordinal <= previous || generation === 0n || incarnationId === 0n || requestId === 0n || transition > 2 || errno > 4095) protocol("Invalid JS trace identity or transition"); previous = ordinal; ordinals.add(ordinal);
    let operation: JSProcessTraceEvent["operation"];
    if (number < 65536) operation = { kind: "syscall", number };
    else if (number === 65536) operation = { kind: "realpath" };
    else if (number === 65537) operation = { kind: "info" };
    else if (number === 65538) operation = { kind: "spawn" };
    else if (number === 65539) operation = { kind: "cancel" };
    else if (number === 65540) operation = { kind: "prepare-thread" };
    else if (number === 65541) operation = { kind: "start-thread" };
    else if (number === 65542) operation = { kind: "stop-thread" };
    else if (number === 65543) operation = { kind: "wait-thread" };
    else if (number === 65544) operation = { kind: "reap-thread" };
    else if (number === 65545) operation = { kind: "path-info" };
    else if (number === 65546) operation = { kind: "prepare-thread-eval" };
    else if (number === 65547) operation = { kind: "umask" };
    else if (number === 65548) operation = { kind: "path-search" };
    else if (number === 65549) operation = { kind: "poll-pipes" }; else protocol("Invalid JS service operation");
    events.push({ ordinal, generation, incarnationId, requestId, pid, tid, operation, transition: transition === 0 ? "admitted" : transition === 1 ? "completed" : "retired", errno: errno === 0 ? null : errno });
  }
  previous = 0n;
  for (let index = 0; index < placementCount; index++) {
    const ordinal = r.u64(), pid = decodeProcessId(r.u32()), tid = integer(r.u32(), "JS native task", 1, 0x7fff_ffff), addressSpaceId = r.u64(), runtime = r.u8(), placement = r.u8();
    if (ordinal <= previous || ordinals.has(ordinal) || addressSpaceId === 0n || runtime > 1 || placement > 1) protocol("Invalid command placement identity");
    previous = ordinal; ordinals.add(ordinal);
    const common = { ordinal, pid, tid, addressSpaceId, runtime: runtime === 0 ? "node" as const : "bun" as const };
    if (placement === 0) {
      const code = r.u32(), reason = rejectionReasons.get(code); if (reason === undefined || version < 16 && code > 38) protocol("Invalid command rejection reason");
      const metadata = placementMetadata(r, version);
      if (metadata.environment !== null && reason !== "unsupported-environment") protocol("Environment detail has an unrelated rejection reason");
      placements.push({ ...common, ...metadata, placement: "linux", reason });
    } else {
      const generation = r.u64(), incarnationId = r.u64(), dependencyGeneration = r.u64(), basisCode = r.u8();
      if (generation === 0n || incarnationId === 0n || dependencyGeneration === 0n || dependencyGeneration >= 1n << 62n || basisCode > 1) protocol("Invalid browser placement identity");
      const basis = basisCode === 0 ? "qualified" as const : "no-addons" as const;
      const { environment, ...metadata } = placementMetadata(r, version);
      if (environment !== null) protocol("Admitted process carries an environment rejection");
      if (metadata.profile === null) protocol("Admitted process has no capability profile");
      const entry = metadata.entry;
      if (entry !== null && !entry.startsWith("/workspace/")
        && metadata.codeRoots?.some(root => root.kind === "image" && (entry === root.path || entry.startsWith(root.path + "/"))) !== true) protocol("Admitted entry is outside the qualified code roots");
      placements.push({ ...common, ...metadata, placement: "browser", generation, incarnationId, dependencyGeneration, basis });
    }
  }
  return { dropped, events, placements, failures: decodeLateFailures(r, failureCount, ordinals) };
}

function decodeLateFailures(r: Reader, count: number, ordinals: ReadonlySet<bigint>): JSProcessLateFailureEvent[] {
  const failures: JSProcessLateFailureEvent[] = [];
  let previous = 0n;
  for (let index = 0; index < count; index++) {
    const ordinal = r.u64(), pid = decodeProcessId(r.u32()), session = r.u32(), generation = r.u64(), incarnationId = r.u64(), kind = lateFailureKind(r.u8());
    const detail = new TextDecoder().decode(r.raw(r.u8()));
    if (ordinal <= previous || ordinals.has(ordinal) || generation === 0n || incarnationId === 0n || kind === undefined || detail !== lateFailureDetail(detail)) protocol("Invalid late-failure record");
    previous = ordinal;
    failures.push({ ordinal, pid, session: session === 0 ? null : decodeProcessId(session), generation, incarnationId, kind, detail });
  }
  r.end(); return failures;
}

function placementMetadata(r: Reader, version: number): Pick<JSProcessPlacementEvent, "parentPid" | "entry" | "profile" | "codeRoots"> & { readonly environment: AccelerationEnvironmentRejection | null } {
  const parent = r.u32(), entry = r.text(4095), identity = r.text(255), tag = r.u8();
  if (identity !== "" && identity !== "node24-bun1-v1" && identity !== "native-parity-fixture-v1") protocol("Invalid placement capability profile");
  if (entry !== "" && (!entry.startsWith("/") || /[\0\r\n]/u.test(entry) || entry.split("/").slice(1).some(part => part === "" || part === "." || part === ".."))) protocol("Invalid placement entry");
  let environment: AccelerationEnvironmentRejection | null = null;
  if (tag !== 0) {
    const category = environmentCategories[tag - 1], variable = r.text(255);
    if (category === undefined || !/^[!-~]*$/u.test(variable) || variable === "" && category !== "malformed-variable") protocol("Invalid environment rejection detail");
    environment = { variable, category };
  }
  const codeRoots = version < 16 ? undefined : readNativeRoots(r).map(root => ({ kind: root.kind, path: root.path, contentSHA256: root.kind === "image" ? root.sha256 : null }));
  return { parentPid: parent === 0 ? null : decodeProcessId(parent), entry: entry === "" ? null : entry, profile: identity === "" ? null : identity, environment, ...(codeRoots === undefined ? {} : { codeRoots }) };
}
