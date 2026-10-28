import { exactKeys, integer, record, string } from "./decode.ts";
import { VMError } from "./errors.ts";

export const NEXT_MEMORY_EXCEPTION = "next16.2.12-memory-observability-v2";

export interface AssistanceArtifact { readonly sha256: string; readonly bytes: number }
export interface AssistanceArtifacts {
  readonly version: 4;
  readonly nextMemoryException: typeof NEXT_MEMORY_EXCEPTION;
  readonly profile: "node24-next16-v1";
  /** Runtime JavaScript transformer; never a replacement for Next's compiler. */
  readonly compiler: AssistanceArtifact;
  readonly runtime: AssistanceArtifact;
  readonly httpParser: AssistanceArtifact;
  readonly nextCompiler: {
    readonly version: "16.2.12";
    readonly bindings: AssistanceArtifact;
    readonly wasm: AssistanceArtifact;
  };
}

export function decodeAssistanceArtifacts(value: unknown): AssistanceArtifacts {
  const input = record(value, "assistance artifacts");
  exactKeys(input, ["version", "profile", "compiler", "runtime", "nextCompiler", "httpParser", "nextMemoryException"]);
  if (input["version"] !== 4 || input["profile"] !== "node24-next16-v1" || input["nextMemoryException"] !== NEXT_MEMORY_EXCEPTION) {
    throw new VMError("PROTOCOL_ERROR", "Unsupported assistance artifact manifest");
  }
  const next = record(input["nextCompiler"], "Next compiler artifacts");
  exactKeys(next, ["version", "bindings", "wasm"]);
  if (next["version"] !== "16.2.12") throw new VMError("PROTOCOL_ERROR", "Unsupported Next compiler version");
  return { version: 4, nextMemoryException: NEXT_MEMORY_EXCEPTION, profile: "node24-next16-v1",
    httpParser: artifact(input["httpParser"], 1024 * 1024),
    compiler: artifact(input["compiler"], 32 * 1024 * 1024),
    runtime: artifact(input["runtime"], 4 * 1024 * 1024),
    nextCompiler: { version: "16.2.12", bindings: artifact(next["bindings"], 1024 * 1024),
      wasm: artifact(next["wasm"], 64 * 1024 * 1024) } };
}

function artifact(value: unknown, limit: number): AssistanceArtifact {
  const input = record(value, "assistance artifact");
  exactKeys(input, ["sha256", "bytes"]);
  const sha256 = string(input["sha256"], "artifact digest");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new VMError("PROTOCOL_ERROR", "Invalid artifact digest");
  return { sha256, bytes: integer(input["bytes"], "artifact length", 1, limit) };
}

export function matchAssistanceArtifacts(value: unknown, expected: AssistanceArtifacts): AssistanceArtifacts {
  const actual = decodeAssistanceArtifacts(value);
  for (const role of ["compiler", "runtime", "httpParser"] as const) {
    if (actual[role].sha256 !== expected[role].sha256 || actual[role].bytes !== expected[role].bytes) {
      throw new VMError("PROTOCOL_ERROR", "Assistance artifact identity differs from the SDK build", { role });
    }
  }
  for (const role of ["bindings", "wasm"] as const) {
    if (actual.nextCompiler[role].sha256 !== expected.nextCompiler[role].sha256
      || actual.nextCompiler[role].bytes !== expected.nextCompiler[role].bytes) {
      throw new VMError("PROTOCOL_ERROR", "Next compiler artifact identity differs from the SDK build", { role });
    }
  }
  return actual;
}

export async function loadAssistanceManifest(url: URL, expected: AssistanceArtifacts, signal: AbortSignal): Promise<AssistanceArtifacts> {
  const bytes = await fetchBytes(url, 4096, signal);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return matchAssistanceArtifacts(value, expected);
}

export async function loadAssistanceArtifact(url: URL, expected: AssistanceArtifact, signal = AbortSignal.timeout(60_000)): Promise<Uint8Array<ArrayBuffer>> {
  artifact(expected, 64 * 1024 * 1024);
  const bytes = await fetchBytes(url, expected.bytes, signal);
  if (bytes.byteLength !== expected.bytes) throw new VMError("PROTOCOL_ERROR", "Assistance artifact length mismatch");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const actual = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected.sha256) throw new VMError("PROTOCOL_ERROR", "Assistance artifact integrity mismatch");
  return bytes;
}

async function fetchBytes(url: URL, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal, credentials: "omit", redirect: "error", cache: "no-store" });
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => { /* Preserve the download failure. */ });
    throw new VMError("CORE_LOAD_FAILED", "Assistance artifact could not be loaded");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximum);
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maximum - length) throw new VMError("PROTOCOL_ERROR", "Assistance artifact exceeds its declared length");
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => { /* Preserve the integrity/transport failure. */ });
    throw error;
  } finally { reader.releaseLock(); }
  return bytes.subarray(0, length);
}
