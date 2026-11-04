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
import { isModuleCommandName, moduleCommandPath } from "./runtime/module-command-names.js";
import type { ModuleReach } from "./wasm/reach.js";

/** Rust's closed bridge service operations by number; 65550 (a signal's host disposition) exists from trace 17, 65551
 * and 65552 (descriptor-relative times, the timed poll) from Userspace API 147. */
const serviceOperations = [
  [65536, "realpath"], [65537, "info"], [65538, "spawn"], [65539, "cancel"], [65540, "prepare-thread"], [65541, "start-thread"],
  [65542, "stop-thread"], [65543, "wait-thread"], [65544, "reap-thread"], [65545, "path-info"], [65546, "prepare-thread-eval"],
  [65547, "umask"], [65548, "path-search"], [65549, "poll-pipes"], [65550, "signal-disposition"], [65551, "utimensat-at"],
  [65552, "poll-timed"],
] as const;
type ServiceOperation = typeof serviceOperations[number][1];
const serviceOperationKinds: ReadonlyMap<number, ServiceOperation> = new Map(serviceOperations);
export interface JSProcessTraceEvent {
  readonly ordinal: bigint; readonly generation: bigint; readonly incarnationId: bigint; readonly requestId: bigint; readonly pid: ProcessId; readonly tid: number;
  /** Linux x86-64 syscall number, or a closed bridge service tag. No instruction address exists. */
  readonly operation: { readonly kind: "syscall"; readonly number: number } | { readonly kind: ServiceOperation };
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
  [41, "module-command-unregistered"], [42, "module-command-concurrency"],
] as const;
export type AccelerationRejectionReason = typeof rejectionCodes[number][1];
const rejectionReasons: ReadonlyMap<number, AccelerationRejectionReason> = new Map(rejectionCodes);
/** The newest reason code of each trace version that has placements. */
const lastReason: ReadonlyMap<number, number> = new Map([[15, 38], [16, 40], [17, 42], [18, 42]]);
/** A module command runs in Linux for its own reasons (41, 42), a full command table (36) or the command context gate (1-10). */
const moduleCommandReasons: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 36, 41, 42]);
type LinuxPlacement = { readonly placement: "linux"; readonly reason: AccelerationRejectionReason; readonly environment: AccelerationEnvironmentRejection | null };
export type JSProcessPlacementEvent = {
  readonly ordinal: bigint; readonly pid: ProcessId; readonly parentPid: ProcessId | null; readonly entry: string | null; readonly tid: number; readonly addressSpaceId: bigint;
  readonly profile: NativeProcessProfile["identity"] | null;
  /** Present in trace version 16 and later; content identity is available for immutable image packages. */
  readonly codeRoots?: readonly { readonly kind: "dependencies" | "store" | "image"; readonly path: string; readonly contentSHA256: string | null }[];
} & (
  /** A `node` or `bun` launch; `runtime` repeats the subject. */
  ({ readonly subject: "node" | "bun"; readonly runtime: "node" | "bun" } & (LinuxPlacement
    | { readonly placement: "browser"; readonly generation: bigint; readonly incarnationId: bigint; readonly dependencyGeneration: bigint; readonly basis: NativeProcessProfile["basis"] }))
  /** Trace 17 (ADR 0027): the engine stub of a module command, which runs either in Linux or as its page module's
   * worker for `registration`. Its `entry` is the stub's path; it has no JavaScript runtime. */
  | ({ readonly subject: "module-command"; readonly runtime: null } & (LinuxPlacement
    | { readonly placement: "browser-module"; readonly generation: bigint; readonly incarnationId: bigint; readonly registration: number }))
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
/**
 * Trace 18 (engine ADR 0029): a module process's request refused before its owner ran it, because the destination lies
 * beyond the network reach its module declared. The request's own service row carries EACCES.
 */
export interface JSProcessRefusalEvent {
  readonly ordinal: bigint; readonly generation: bigint; readonly incarnationId: bigint; readonly requestId: bigint; readonly pid: ProcessId;
  readonly reason: "module-network-reach";
  readonly declared: ModuleReach;
  readonly attempted: "vm" | "internet";
  /** The destination it named; a Unix socket's path is not recorded. */
  readonly destination: { readonly family: "unix" } | { readonly family: "ipv4" | "ipv6"; readonly address: string; readonly port: number };
}
export interface JSProcessTrace {
  /** All four lists share one bounded ring and monotonic ordinal sequence. */
  readonly dropped: bigint;
  readonly events: readonly JSProcessTraceEvent[];
  readonly placements: readonly JSProcessPlacementEvent[];
  readonly failures: readonly JSProcessLateFailureEvent[];
  /** Empty before trace 18. */
  readonly refusals: readonly JSProcessRefusalEvent[];
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
  if (version < 15 || version > 18) protocol("JS trace version mismatch");
  const dropped = r.u64(), count = r.u32(), placementCount = r.u32(), failureCount = r.u32(), refusalCount = version < 18 ? 0 : r.u32(), events: JSProcessTraceEvent[] = [], placements: JSProcessPlacementEvent[] = [];
  if (count + placementCount + failureCount + refusalCount > 4096) protocol("JS trace exceeds capacity");
  const ordinals = new Set<bigint>();
  let previous = 0n;
  for (let index = 0; index < count; index++) {
    const ordinal = r.u64(), generation = r.u64(), incarnationId = r.u64(), requestId = r.u64(), pid = decodeProcessId(r.u32()), tid = integer(r.u32(), "JS native task", 1, 0x7fff_ffff), number = r.u32(), transition = r.u32(), errno = r.u32();
    if (ordinal <= previous || generation === 0n || incarnationId === 0n || requestId === 0n || transition > 2 || errno > 4095) protocol("Invalid JS trace identity or transition"); previous = ordinal; ordinals.add(ordinal);
    events.push({ ordinal, generation, incarnationId, requestId, pid, tid, operation: serviceOperation(number, version), transition: transition === 0 ? "admitted" : transition === 1 ? "completed" : "retired", errno: errno === 0 ? null : errno });
  }
  previous = 0n;
  for (let index = 0; index < placementCount; index++) {
    const ordinal = r.u64(), pid = decodeProcessId(r.u32()), tid = integer(r.u32(), "JS native task", 1, 0x7fff_ffff), addressSpaceId = r.u64(), subject = r.u8(), placement = r.u8();
    // Trace 17 names the subject (0 node, 1 bun, 2 module command), whose browser placements take tag 1 or 2 respectively.
    if (ordinal <= previous || ordinals.has(ordinal) || addressSpaceId === 0n || subject > (version < 17 ? 1 : 2) || placement > 2 || placement !== 0 && (placement === 2) !== (subject === 2)) protocol("Invalid command placement identity");
    previous = ordinal; ordinals.add(ordinal);
    const common = { ordinal, pid, tid, addressSpaceId };
    placements.push(subject === 2 ? modulePlacement(r, common, placement) : nativePlacement(r, version, { ...common, subject: subject === 0 ? "node" : "bun", runtime: subject === 0 ? "node" : "bun" }, placement));
  }
  const failures = decodeLateFailures(r, failureCount, ordinals), refusals = decodeRefusals(r, refusalCount, ordinals); r.end();
  return { dropped, events, placements, failures, refusals };
}

function serviceOperation(number: number, version: number): JSProcessTraceEvent["operation"] {
  if (number < 65536) return { kind: "syscall", number };
  const kind = version < 17 && number === 65550 ? undefined : serviceOperationKinds.get(number);
  return kind === undefined ? protocol("Invalid JS service operation") : { kind };
}

type PlacementIdentity = Pick<JSProcessPlacementEvent, "ordinal" | "pid" | "tid" | "addressSpaceId">;

function linuxReason(r: Reader, version: number): readonly [number, AccelerationRejectionReason] {
  const code = r.u32(), reason = rejectionReasons.get(code);
  if (reason === undefined || code > (lastReason.get(version) ?? 0)) protocol("Invalid command rejection reason");
  return [code, reason];
}

function nativePlacement(r: Reader, version: number, common: PlacementIdentity & { readonly subject: "node" | "bun"; readonly runtime: "node" | "bun" }, placement: number): JSProcessPlacementEvent {
  if (placement === 0) {
    const [code, reason] = linuxReason(r, version);
    const metadata = placementMetadata(r, version);
    if (code === 41 || code === 42) protocol("A module command reason names a node or bun launch");
    if (metadata.environment !== null && reason !== "unsupported-environment") protocol("Environment detail has an unrelated rejection reason");
    return { ...common, ...metadata, placement: "linux", reason };
  }
  const generation = r.u64(), incarnationId = r.u64(), dependencyGeneration = r.u64(), basisCode = r.u8();
  if (generation === 0n || incarnationId === 0n || dependencyGeneration === 0n || dependencyGeneration >= 1n << 62n || basisCode > 1) protocol("Invalid browser placement identity");
  const basis = basisCode === 0 ? "qualified" as const : "no-addons" as const;
  const { environment, ...metadata } = placementMetadata(r, version);
  if (environment !== null) protocol("Admitted process carries an environment rejection");
  if (metadata.profile === null) protocol("Admitted process has no capability profile");
  const entry = metadata.entry;
  if (entry !== null && !entry.startsWith("/workspace/")
    && metadata.codeRoots?.some(root => root.kind === "image" && (entry === root.path || entry.startsWith(root.path + "/"))) !== true) protocol("Admitted entry is outside the qualified code roots");
  return { ...common, ...metadata, placement: "browser", generation, incarnationId, dependencyGeneration, basis };
}

/** Trace 17 only (subject 2 is refused earlier): a module command's stub ran in Linux or as its page module. */
function modulePlacement(r: Reader, identity: PlacementIdentity, placement: number): JSProcessPlacementEvent {
  const common = { ...identity, subject: "module-command" as const, runtime: null };
  if (placement === 0) {
    const [code, reason] = linuxReason(r, 17);
    const { environment, ...metadata } = placementMetadata(r, 17);
    if (!moduleCommandReasons.has(code) || environment !== null || metadata.profile !== null || metadata.entry === null) protocol("Invalid module command placement");
    return { ...common, ...metadata, placement: "linux", reason, environment };
  }
  const generation = r.u64(), incarnationId = r.u64(), registration = r.u32();
  const { environment, ...metadata } = placementMetadata(r, 17), name = metadata.entry?.slice("/usr/local/bin/".length) ?? "";
  if (generation === 0n || incarnationId === 0n || registration === 0 || environment !== null || metadata.profile !== null
    || !isModuleCommandName(name) || metadata.entry !== moduleCommandPath(name)) protocol("Invalid module command placement");
  return { ...common, ...metadata, placement: "browser-module", generation, incarnationId, registration };
}

function decodeLateFailures(r: Reader, count: number, ordinals: Set<bigint>): JSProcessLateFailureEvent[] {
  const failures: JSProcessLateFailureEvent[] = [];
  let previous = 0n;
  for (let index = 0; index < count; index++) {
    const ordinal = r.u64(), pid = decodeProcessId(r.u32()), session = r.u32(), generation = r.u64(), incarnationId = r.u64(), kind = lateFailureKind(r.u8());
    const detail = new TextDecoder().decode(r.raw(r.u8()));
    if (ordinal <= previous || ordinals.has(ordinal) || generation === 0n || incarnationId === 0n || kind === undefined || detail !== lateFailureDetail(detail)) protocol("Invalid late-failure record");
    previous = ordinal;
    failures.push({ ordinal, pid, session: session === 0 ? null : decodeProcessId(session), generation, incarnationId, kind, detail });
    ordinals.add(ordinal);
  }
  return failures;
}

const REACHES: readonly ModuleReach[] = ["none", "vm", "internet"];

/** Trace 18 refusal rows: u64 ordinal, generation, process, request; u32 pid; u8 reason 1, declared reach, attempted scope; u16 family, u16 port; 16-byte address. */
function decodeRefusals(r: Reader, count: number, ordinals: ReadonlySet<bigint>): JSProcessRefusalEvent[] {
  const refusals: JSProcessRefusalEvent[] = [];
  let previous = 0n;
  for (let index = 0; index < count; index++) {
    const ordinal = r.u64(), generation = r.u64(), incarnationId = r.u64(), requestId = r.u64(), pid = decodeProcessId(r.u32()), reason = r.u8(), declared = REACHES[r.u8()], scope = r.u8();
    const family = r.u16(), port = r.u16(), address = r.raw(16);
    const attempted = scope === 1 ? "vm" as const : scope === 2 ? "internet" as const : undefined;
    if (ordinal <= previous || ordinals.has(ordinal) || generation === 0n || incarnationId === 0n || requestId === 0n || reason !== 1 || declared === undefined || attempted === undefined
      || declared === "internet" || declared === "vm" && attempted === "vm") protocol("Invalid module network reach refusal");
    previous = ordinal;
    refusals.push({ ordinal, generation, incarnationId, requestId, pid, reason: "module-network-reach", declared, attempted, destination: refusalDestination(family, port, address) });
  }
  return refusals;
}

function refusalDestination(family: number, port: number, address: Uint8Array): JSProcessRefusalEvent["destination"] {
  if (family === 1 && port === 0 && address.every(byte => byte === 0)) return { family: "unix" };
  if (family === 2 && address.subarray(4).every(byte => byte === 0)) return { family: "ipv4", address: Array.from(address.subarray(0, 4)).join("."), port };
  if (family === 10) {
    const view = new DataView(address.buffer, address.byteOffset, 16);
    return { family: "ipv6", address: Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2).toString(16)).join(":"), port };
  }
  return protocol("Invalid refused destination");
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
