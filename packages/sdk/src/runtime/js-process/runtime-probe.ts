import { Writer, protocol } from "./codec.ts";
import type { NativeRuntimeBuild } from "../userspace-command-abi.ts";
import type { ProcessTermination } from "../protocol/agent.ts";

/**
 * ADR 0026, 1.5: a `node` or `bun` binary in no catalog row is probed once. Rust asks; the SDK runs
 * the binary in Linux on this fixed script and reports what it printed, a build Rust checks
 * against the families the fast path implements. The SDK decides nothing about placement.
 */
/** Host time a probe may take before it is killed and reported as a timeout. */
export const RUNTIME_PROBE_DEADLINE_MS = 20_000;
/** More output than six bounded lines can need. */
export const RUNTIME_PROBE_MAX_OUTPUT = 72 * 1024;
const MAX_FIELD = 64, MAX_CONFIG = 64 * 1024, MAX_PATH = 4095;

export type RuntimeProbeReport = { readonly kind: "build"; readonly build: NativeRuntimeBuild } | { readonly kind: "failed"; readonly detail: string } | { readonly kind: "cancelled" };
/** How the probe process ended, or why it was stopped. */
export type RuntimeProbeEnding = ProcessTermination | "timeout" | "overflow";

function vmCommand(operation: 11 | 12 | 13 | 14): Writer { return new Writer().u32(1).u8(operation).u64(0n).u64(0n); }

/** Command operation 14: Rust alone selects bounded background trials after mutations settle. */
export function encodeAccelerationBackgroundPoll(milliseconds: bigint): Uint8Array<ArrayBuffer> { return vmCommand(14).u64(milliseconds).finish(); }
export function decodeAccelerationBackgroundPending(bytes: Uint8Array): boolean | "disabled" {
  if (bytes.byteLength !== 1 || (bytes[0] !== 0 && bytes[0] !== 1 && bytes[0] !== 2)) protocol("Invalid acceleration background pending flag");
  if (bytes[0] === 2) return "disabled";
  return bytes[0] === 1;
}

/** Command operation 13: takes the notification once; the SDK retains it until persisted. */
export function encodeAccelerationKnowledgeChanged(): Uint8Array<ArrayBuffer> { return vmCommand(13).finish(); }

export function decodeAccelerationKnowledgeChanged(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 1 || (bytes[0] !== 0 && bytes[0] !== 1)) protocol("Invalid acceleration knowledge change");
  return bytes[0] === 1;
}

/** Command operation 11: the next binary Rust asks about, or nothing. */
export function encodeRuntimeProbeTake(): Uint8Array<ArrayBuffer> { return vmCommand(11).finish(); }

function canonical(path: string): boolean {
  return path.startsWith("/") && path.split("/").slice(1).every(part => part !== "" && part !== "." && part !== ".." && !Array.from(part).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
}

/** Rust's request: the binary's digest as 64 lowercase hex digits, then its canonical path. */
export function decodeRuntimeProbeRequest(bytes: Uint8Array): { readonly sha256: string; readonly path: string } | undefined {
  if (bytes.byteLength === 0) return undefined;
  if (bytes.byteLength <= 64 || bytes.byteLength > 64 + MAX_PATH) protocol("Invalid runtime probe request");
  let sha256: string, path: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    sha256 = decoder.decode(bytes.subarray(0, 64)); path = decoder.decode(bytes.subarray(64));
  } catch { return protocol("Invalid runtime probe request"); }
  if (!/^[0-9a-f]{64}$/u.test(sha256) || !canonical(path)) protocol("Invalid runtime probe request");
  return { sha256, path };
}

/** Command operation 12: the digest, then 0 and the build, 1 and how the probe failed, or 2. */
export function encodeRuntimeProbeReport(sha256: string, report: RuntimeProbeReport): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) protocol("Invalid runtime probe digest");
  const writer = vmCommand(12).raw(new TextEncoder().encode(sha256));
  if (report.kind === "cancelled") return writer.u8(2).finish();
  if (report.kind === "failed") {
    const detail = new TextEncoder().encode(report.detail);
    return writer.u8(1).u8(detail.byteLength).raw(detail).finish();
  }
  writer.u8(0);
  const { version, node, uv, napi, bun, config } = report.build;
  for (const field of [version, node, uv, napi, bun]) {
    const bytes = new TextEncoder().encode(field);
    writer.raw(Uint8Array.of(bytes.byteLength & 0xff, bytes.byteLength >> 8)).raw(bytes);
  }
  const bytes = new TextEncoder().encode(config);
  return writer.u32(bytes.byteLength).raw(bytes).finish();
}

const failed = (detail: string): RuntimeProbeReport => ({ kind: "failed", detail });
const printable = (value: string) => value.length <= MAX_FIELD && /^[\x20-\x7e]*$/u.test(value);

/** The probe's six lines (version, versions.node, uv, napi, bun, config JSON), else how it ended. */
export function parseRuntimeProbeOutput(stdout: Uint8Array, ending: RuntimeProbeEnding): RuntimeProbeReport {
  if (ending === "timeout") return failed("timeout");
  if (ending === "overflow") return failed("output too large");
  if (ending.kind === "signal") return failed(`signal ${String(ending.signal)}`);
  if (ending.code !== 0) return failed(`exit ${String(ending.code)}`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout); } catch { return failed("invalid output"); }
  const lines = text.split("\n");
  const [version, node, uv, napi, bun, config, rest] = lines;
  if (lines.length !== 7 || rest !== "" || version === undefined || node === undefined || uv === undefined || napi === undefined || bun === undefined || config === undefined
    || ![version, node, uv, napi, bun].every(printable) || new TextEncoder().encode(config).byteLength > MAX_CONFIG) return failed("invalid output");
  let parsed: unknown;
  try { parsed = JSON.parse(config); } catch { return failed("invalid output"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failed("invalid output");
  return { kind: "build", build: { version, node, uv, napi, bun, config } };
}
