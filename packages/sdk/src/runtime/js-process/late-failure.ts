import { exactKeys, integer, record, string } from "../decode.ts";
import { VMError } from "../errors.ts";
import { protocol } from "./codec.ts";
import { decodeProcessId, type ProcessId } from "../../values.js";

/** ADR 0026: why an admitted program failed after it started. Rust owns the codes
 * (`LateFailureKind`), the record and the decision; the SDK only names what it saw. */
export type LateFailureKind = "unavailable-builtin" | "unqualified-addon" | "unsupported-node-api" | "eval-worker";
export interface LateFailure { readonly kind: LateFailureKind; readonly detail: string }
export interface LateFailureNotice { readonly pid: number; readonly session: number; readonly record: Uint8Array<ArrayBuffer> }
/** One late failure as the page sees it, after Rust remembered the program. */
export interface AccelerationNotice {
  readonly pid: ProcessId;
  /** The session leader's PID (a terminal tab's shell), or null when the process had none. */
  readonly session: ProcessId | null;
  readonly kind: LateFailureKind;
  readonly detail: string;
  /** The sentence the terminal printed: what failed, and that the next run uses full Linux. */
  readonly message: string;
}

const CODES: Readonly<Record<LateFailureKind, number>> = { "unavailable-builtin": 1, "unqualified-addon": 2, "unsupported-node-api": 3, "eval-worker": 4 };
const KINDS: readonly LateFailureKind[] = ["unavailable-builtin", "unqualified-addon", "unsupported-node-api", "eval-worker"];
const COMMAND_REPORT = 5;
const MAX_DETAIL = 255;

/** Printable ASCII without line breaks, at most 255 bytes: a module or operation name. */
export function lateFailureDetail(value: string): string {
  return Array.from(value).filter(character => character >= " " && character <= "~").join("").slice(0, MAX_DETAIL);
}

/** The limitation an error names in its structured detail; any other failure is not remembered. */
export function lateFailureOf(error: unknown): LateFailure | undefined {
  if (!(error instanceof VMError) || error.detail === undefined) return undefined;
  const kind = error.detail["lateFailure"], subject = error.detail["subject"];
  if (typeof kind !== "string" || !isLateFailureKind(kind) || typeof subject !== "string") return undefined;
  return { kind, detail: lateFailureDetail(subject) };
}

/** The kind Rust's code names, or undefined for a code this SDK does not know. */
export function lateFailureKind(code: number): LateFailureKind | undefined {
  return KINDS.find(kind => CODES[kind] === code);
}

function isLateFailureKind(value: string): value is LateFailureKind {
  return Object.hasOwn(CODES, value);
}

/** Command operation 5 for one live admitted launch (Userspace API 142). */
export function encodeLateFailureReport(request: { readonly generation: bigint; readonly id: bigint }, failure: LateFailure): Uint8Array<ArrayBuffer> {
  const detail = new TextEncoder().encode(lateFailureDetail(failure.detail));
  const bytes = new Uint8Array(23 + detail.byteLength), view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true); bytes[4] = COMMAND_REPORT; view.setBigUint64(5, request.generation, true); view.setBigUint64(13, request.id, true);
  bytes[21] = CODES[failure.kind]; bytes[22] = detail.byteLength; bytes.set(detail, 23);
  return bytes;
}

/** Rust's notice: the failing PID, its session, then the record file to persist. */
export function decodeLateFailureNotice(bytes: Uint8Array): LateFailureNotice {
  if (bytes.byteLength < 28 || bytes.byteLength > 8 * 1024 * 1024) protocol("Invalid late-failure notice length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "OXAF" || view.getUint32(4, true) !== 1 || new TextDecoder().decode(bytes.subarray(16, 20)) !== "OXAK") protocol("Invalid late-failure notice");
  return { pid: view.getUint32(8, true), session: view.getUint32(12, true), record: new Uint8Array(bytes.subarray(16)) };
}

/** The notice fields every page-facing message carries; the sentence is derived on decode. */
export function encodeAccelerationNotice(notice: Pick<LateFailureNotice, "pid" | "session">, failure: LateFailure): { readonly pid: number; readonly session: number; readonly kind: LateFailureKind; readonly detail: string } {
  return { pid: notice.pid, session: notice.session, kind: failure.kind, detail: failure.detail };
}

/** A decoded notice's fields again, for a hosted frame's event. */
export function accelerationNoticeWire(notice: AccelerationNotice): ReturnType<typeof encodeAccelerationNotice> {
  return encodeAccelerationNotice({ pid: notice.pid, session: notice.session ?? 0 }, notice);
}

export function decodeAccelerationNotice(input: unknown): AccelerationNotice {
  const value = record(input, "acceleration notice"); exactKeys(value, ["pid", "session", "kind", "detail"]);
  const failure = decodeLateFailure({ kind: value["kind"], detail: value["detail"] });
  const session = integer(value["session"], "acceleration notice session", 0, 0x7fff_ffff);
  return { pid: decodeProcessId(value["pid"]), session: session === 0 ? null : decodeProcessId(session), ...failure, message: lateFailureSentence(failure) };
}

/** One plain sentence for the terminal: what failed and that the next run uses full Linux. */
export function lateFailureSentence(failure: LateFailure): string {
  switch (failure.kind) {
    case "unavailable-builtin": return `This program uses ${failure.detail}, which the fast path does not provide; its next run uses full Linux.`;
    case "unqualified-addon": return `This program loaded the add-on ${failure.detail}, which the fast path cannot vouch for; its next run uses full Linux.`;
    case "unsupported-node-api": return `This program's add-on called ${failure.detail}, which the fast path does not provide yet; its next run uses full Linux.`;
    case "eval-worker": return "This program started a worker thread from source text, which the fast path does not run; its next run uses full Linux.";
  }
}

export function lateFailureError(kind: LateFailureKind, message: string, subject: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", message, { lateFailure: kind, subject });
}

/** The `late-failure` message a process posts before it exits on an uncaught limitation. */
export function decodeLateFailure(input: unknown): LateFailure {
  const value = record(input, "late failure"); exactKeys(value, ["kind", "detail"]);
  const kind = string(value["kind"], "late failure kind"), detail = string(value["detail"], "late failure detail");
  if (!isLateFailureKind(kind) || detail !== lateFailureDetail(detail)) protocol("Invalid late failure");
  return { kind, detail };
}

/** How a process ends, for the late-failure report: an uncaught error, or an exit code. */
export interface LateFailureReporter {
  /** A fast-path limitation is explained in one sentence and handed on; any other error is
   * printed, and a missing export the process touched is explained and handed on. */
  uncaught(error: unknown): void;
  /** A failing exit hands on a missing export the process touched. */
  exited(code: number): void;
}

/** Hands at most one late failure per process to Rust, so it remembers the program, and prints
 * its one-sentence explanation. Without a receiver it only prints errors. */
export function lateFailureReporter(print: (value: unknown) => void, receive: ((failure: LateFailure) => void) | undefined, touched: () => LateFailure | undefined): LateFailureReporter {
  let reported = false;
  const report = (failure: LateFailure | undefined): void => {
    if (failure === undefined || receive === undefined || reported) return;
    reported = true;
    print(lateFailureSentence(failure));
    receive(failure);
  };
  return {
    uncaught: error => {
      // The limitation is the fast path's, not the program's error: its dump would only show
      // the browser layer's internals.
      const limitation = receive === undefined ? undefined : lateFailureOf(error);
      if (limitation === undefined) print(error);
      report(limitation ?? touched());
    },
    exited: code => { if (code !== 0) report(touched()); },
  };
}
