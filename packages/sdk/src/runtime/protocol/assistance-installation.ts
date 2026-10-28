import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { decodeAssistanceCredit, encodeAssistanceCredit, validateAssistanceCredit, type AssistanceCredit } from "./assistance-credit.js";
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { TextEncoder } from "../web-encoding.js";
import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";

/** Private guest-v6 preparation control. Identity is correlation, never peer
 * authentication; only the agent's kernel launch record grants authority. */
export interface InstallationRequest extends AssistanceBinding {
  readonly installation: number;
  readonly sequence: number;
  readonly operation: { readonly kind: "start"; readonly cwd: string; readonly frozenLockfile: boolean }
    | { readonly kind: "stop" | "execute" | "validate-inputs" | "blocked-builds" | "check-current" | "retire" | "materialize" | "capture" | "capture-retire" }
    | { readonly kind: "workspace-capture" | "workspace-capture-retire"; readonly source: "snapshot" | "delta" }
    | { readonly kind: "workspace-capture-read"; readonly source: "snapshot" | "delta"; readonly length: number }
    | { readonly kind: "set-build-policy"; readonly bytes: Uint8Array }
    | { readonly kind: "activate-materialized"; readonly generation: Uint8Array; readonly inputs: Uint8Array }
    | { readonly kind: "stdin"; readonly child: number; readonly bytes: Uint8Array }
    | { readonly kind: "close-stdin"; readonly child: number }
    | { readonly kind: "signal"; readonly child: number; readonly signal: number }
    | { readonly kind: "output-ack"; readonly child: number; readonly stream: "stdout" | "stderr"; readonly sequence: number; readonly bytes: number }
    /** Echo the completed I/O sequence; this does not admit another I/O. */
    | { readonly kind: "acknowledge" }
    | { readonly kind: "read" | "capture-read"; readonly length: number }
    | { readonly kind: "write"; readonly bytes: Uint8Array };
}

export function isInstallationSupervisoryOperation(operation: InstallationRequest["operation"]): boolean {
  return operation.kind === "stop" || operation.kind === "retire" || operation.kind === "capture-retire" || operation.kind === "workspace-capture-retire"
    || operation.kind === "acknowledge" || operation.kind === "signal" || operation.kind === "output-ack";
}

function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid installation request"); }
function dialect(version: number): asserts version is 6 | 7 { if (version !== 6 && version !== 7) invalid(); }
export function validateInstallationRequest(value: unknown): InstallationRequest {
  const input = record(value, "installation request");
  exactKeys(input, ["session", "generation", "installation", "sequence", "operation"]);
  const common = { ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
    installation: integer(input["installation"], "installation identity", 1, 0xffff_ffff),
    sequence: integer(input["sequence"], "installation sequence", 1, 0xffff_ffff) };
  const operation = record(input["operation"], "installation operation");
  if (operation["kind"] === "workspace-capture" || operation["kind"] === "workspace-capture-read" || operation["kind"] === "workspace-capture-retire") {
    if (common.sequence === 0xffff_ffff) invalid();
    const source = operation["source"];
    if (source !== "snapshot" && source !== "delta") invalid();
    if (operation["kind"] === "workspace-capture-read") {
      exactKeys(operation, ["kind", "source", "length"]);
      return { ...common, operation: { kind: operation["kind"], source, length: integer(operation["length"], "workspace capture read length", 1, ASSISTANCE_LIMITS.chunk) } };
    }
    exactKeys(operation, ["kind", "source"]);
    return { ...common, operation: { kind: operation["kind"], source } };
  }
  if ((operation["kind"] === "validate-inputs" || operation["kind"] === "blocked-builds" || operation["kind"] === "check-current" || operation["kind"] === "retire" || operation["kind"] === "materialize" || operation["kind"] === "capture" || operation["kind"] === "capture-read" || operation["kind"] === "capture-retire") && common.sequence === 0xffff_ffff) invalid();
  if (operation["kind"] === "validate-inputs" || operation["kind"] === "blocked-builds" || operation["kind"] === "check-current" || operation["kind"] === "capture" || operation["kind"] === "capture-retire" || operation["kind"] === "materialize" || operation["kind"] === "retire" || operation["kind"] === "stop" || operation["kind"] === "execute" || operation["kind"] === "acknowledge") {
    exactKeys(operation, ["kind"]);
    return { ...common, operation: { kind: operation["kind"] } };
  }
  if (operation["kind"] === "close-stdin") {
    exactKeys(operation, ["kind", "child"]);
    return { ...common, operation: { kind: "close-stdin", child: integer(operation["child"], "child", 1, 0xffff_ffff) } };
  }
  if (operation["kind"] === "signal") {
    exactKeys(operation, ["kind", "child", "signal"]);
    const signal = integer(operation["signal"], "signal", 1, 64);
    if (![1, 2, 9, 15].includes(signal)) invalid();
    return { ...common, operation: { kind: "signal", child: integer(operation["child"], "child", 1, 0xffff_ffff), signal } };
  }
  if (operation["kind"] === "output-ack") {
    exactKeys(operation, ["kind", "child", "stream", "sequence", "bytes"]);
    const stream = operation["stream"];
    if (stream !== "stdout" && stream !== "stderr") invalid();
    return { ...common, operation: { kind: "output-ack", child: integer(operation["child"], "child", 1, 0xffff_ffff), stream,
      sequence: integer(operation["sequence"], "output sequence", 1, 0xffff_ffff), bytes: integer(operation["bytes"], "output bytes", 1, ASSISTANCE_LIMITS.chunk) } };
  }
  if (operation["kind"] === "read" || operation["kind"] === "capture-read") {
    exactKeys(operation, ["kind", "length"]);
    return { ...common, operation: { kind: operation["kind"], length: integer(operation["length"], "installation read length", 1, ASSISTANCE_LIMITS.chunk) } };
  }
  if (operation["kind"] === "activate-materialized") {
    if (common.sequence === 0xffff_ffff) invalid();
    exactKeys(operation, ["kind", "generation", "inputs"]);
    const digest = (value: unknown): Uint8Array => {
      if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== 32) invalid();
      return value;
    };
    return { ...common, operation: { kind: "activate-materialized", generation: digest(operation["generation"]), inputs: digest(operation["inputs"]) } };
  }
  if (operation["kind"] === "set-build-policy" || operation["kind"] === "write" || operation["kind"] === "stdin") {
    if (operation["kind"] === "set-build-policy" && common.sequence === 0xffff_ffff) invalid();
    exactKeys(operation, operation["kind"] === "stdin" ? ["kind", "child", "bytes"] : ["kind", "bytes"]);
    const bytes = operation["bytes"];
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
      || bytes.length === 0 || bytes.length > ASSISTANCE_LIMITS.chunk) invalid();
    if (operation["kind"] === "stdin") return { ...common, operation: { kind: "stdin", child: integer(operation["child"], "child", 1, 0xffff_ffff), bytes } };
    return { ...common, operation: { kind: operation["kind"], bytes } };
  }
  if (operation["kind"] !== "start") invalid();
  exactKeys(operation, ["kind", "cwd", "frozenLockfile"]);
  const cwd = string(operation["cwd"], "installation cwd");
  if (!cwd.isWellFormed() || !cwd.startsWith("/") || new TextEncoder().encode(cwd).length > 4096
    || (cwd !== "/" && cwd.slice(1).split("/").some(part => part === "" || part === "." || part === ".."))) invalid();
  for (const character of cwd) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127 || character === "\\") invalid();
  }
  return { ...common, operation: { kind: "start", cwd, frozenLockfile: boolean(operation["frozenLockfile"], "frozenLockfile") } };
}

export function encodeInstallationRequest(value: unknown, version: number): Uint8Array<ArrayBuffer> {
  dialect(version);
  const request = validateInstallationRequest(value);
  const out = new AgentPayloadWriter(61 + ASSISTANCE_LIMITS.chunk).string(request.session).u32(request.generation)
    .u32(request.installation).u32(request.sequence);
  const operation = request.operation;
  switch (operation.kind) {
    case "start": out.u8(1).u8(operation.frozenLockfile ? 1 : 0).string(operation.cwd); break;
    case "stop": out.u8(2); break;
    case "retire": out.u8(11); break;
    case "materialize": out.u8(12); break;
    case "capture": out.u8(13); break;
    case "capture-read": out.u8(14).u32(operation.length); break;
    case "capture-retire": out.u8(15); break;
    case "workspace-capture": out.u8(16).u8(operation.source === "snapshot" ? 1 : 2); break;
    case "workspace-capture-read": out.u8(17).u8(operation.source === "snapshot" ? 1 : 2).u32(operation.length); break;
    case "workspace-capture-retire": out.u8(18).u8(operation.source === "snapshot" ? 1 : 2); break;
    case "set-build-policy": if (version !== 7) invalid(); out.u8(21).bytes(operation.bytes); break;
    case "activate-materialized": if (version !== 7) invalid(); out.u8(22).bytes(operation.generation).bytes(operation.inputs); break;
    case "execute": out.u8(6); break;
    case "validate-inputs": if (version !== 7) invalid(); out.u8(19); break;
    case "blocked-builds": if (version !== 7) invalid(); out.u8(20); break;
    case "check-current": if (version !== 7) invalid(); out.u8(23); break;
    case "stdin": out.u8(7).u32(operation.child).bytes(operation.bytes); break;
    case "close-stdin": out.u8(8).u32(operation.child); break;
    case "signal": out.u8(9).u32(operation.child).u8(operation.signal); break;
    case "output-ack": out.u8(10).u32(operation.child).u8(operation.stream === "stdout" ? 1 : 2).u32(operation.sequence).u32(operation.bytes); break;
    case "acknowledge": out.u8(5); break;
    case "read": out.u8(3).u32(operation.length); break;
    case "write": out.u8(4).bytes(operation.bytes); break;
  }
  return out.finish();
}

export function decodeInstallationRequest(bytes: Uint8Array, version: number): InstallationRequest {
  dialect(version);
  if (bytes.length < 53 || bytes.length > 61 + ASSISTANCE_LIMITS.chunk) invalid();
  const input = new AgentPayloadReader(bytes);
  const common = { session: input.string(), generation: input.u32(), installation: input.u32(), sequence: input.u32() };
  const tag = input.u8();
  let operation: InstallationRequest["operation"];
  if (tag === 1) {
    const frozen = input.u8();
    if (frozen > 1) invalid();
    operation = { kind: "start", cwd: input.string(), frozenLockfile: frozen === 1 };
  } else if (tag === 2) operation = { kind: "stop" };
  else if (tag === 19 && version === 7) operation = { kind: "validate-inputs" };
  else if (tag === 23 && version === 7) operation = { kind: "check-current" };
  else if (tag === 20 && version === 7) operation = { kind: "blocked-builds" };
  else if (tag === 11) operation = { kind: "retire" };
  else if (tag === 12) operation = { kind: "materialize" };
  else if (tag === 13) operation = { kind: "capture" };
  else if (tag === 14) operation = { kind: "capture-read", length: input.u32() };
  else if (tag === 15) operation = { kind: "capture-retire" };
  else if (tag === 16 || tag === 17 || tag === 18) {
    const sourceTag = input.u8();
    if (sourceTag !== 1 && sourceTag !== 2) invalid();
    const source = sourceTag === 1 ? "snapshot" : "delta";
    operation = tag === 17 ? { kind: "workspace-capture-read", source, length: input.u32() }
      : { kind: tag === 16 ? "workspace-capture" : "workspace-capture-retire", source };
  }
  else if (tag === 3) operation = { kind: "read", length: input.u32() };
  else if (tag === 4) operation = { kind: "write", bytes: input.bytes() };
  else if (tag === 5) operation = { kind: "acknowledge" };
  else if (tag === 21 && version === 7) operation = { kind: "set-build-policy", bytes: input.bytes() };
  else if (tag === 22 && version === 7) operation = { kind: "activate-materialized", generation: input.bytes(), inputs: input.bytes() };
  else if (tag === 6) operation = { kind: "execute" };
  else if (tag === 7) operation = { kind: "stdin", child: input.u32(), bytes: input.bytes() };
  else if (tag === 8) operation = { kind: "close-stdin", child: input.u32() };
  else if (tag === 9) operation = { kind: "signal", child: input.u32(), signal: input.u8() };
  else if (tag === 10) {
    const child = input.u32(); const stream = input.u8();
    if (stream !== 1 && stream !== 2) invalid();
    operation = { kind: "output-ack", child, stream: stream === 1 ? "stdout" : "stderr", sequence: input.u32(), bytes: input.u32() };
  }
  else return invalid();
  input.finish();
  const request = validateInstallationRequest({ ...common, operation });
  const encoded = encodeInstallationRequest(request, version);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) invalid();
  return request;
}

/** Authenticated launcher's first private frame. These are issued grants, never
 * requests to mint authority; the outer VM retains ownership until retirement. */
export interface InstallationBootstrap {
  readonly request: InstallationRequest;
  readonly credits: readonly AssistanceCredit[];
  readonly registry: string;
}

function bootstrap(value: unknown): InstallationBootstrap {
  const input = record(value, "installation bootstrap");
  exactKeys(input, ["request", "credits", "registry"]);
  const request = validateInstallationRequest(input["request"]);
  if (request.operation.kind !== "start" || request.sequence === 0xffff_ffff) invalid();
  const supplied = input["credits"];
  if (!Array.isArray(supplied) || supplied.length !== 4) invalid();
  const credits = supplied.map((credit: unknown) => validateAssistanceCredit(credit, 6));
  const reservations = new Set<number>(); const sequences = new Set<number>();
  for (const [index, credit] of credits.entries()) {
    if (credit.session !== request.session || credit.generation !== request.generation || credit.process !== null
      || credit.kind !== "grant" || credit.producer !== (index < 2 ? "installation-gateway" : "network")
      || credit.pool !== (index % 2 === 0 ? "data" : "control")
      || reservations.has(credit.reservation) || sequences.has(credit.sequence)) invalid();
    reservations.add(credit.reservation); sequences.add(credit.sequence);
  }
  for (const pool of ["data", "control"] as const) {
    const issued = credits.filter(credit => credit.pool === pool);
    if (issued.reduce((total, credit) => total + credit.bytes, 0) > (pool === "data" ? ASSISTANCE_LIMITS.pending - ASSISTANCE_LIMITS.stream : ASSISTANCE_LIMITS.stream)
      || issued.reduce((total, credit) => total + credit.entries, 0) > (pool === "data" ? 4096 : 1024)) invalid();
  }
  const registry = string(input["registry"], "installation registry");
  if (!registry.isWellFormed() || registry.length === 0 || registry.startsWith("\ufeff") || new TextEncoder().encode(registry).length > 4096) invalid();
  for (const character of registry) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) invalid();
  return { request, credits, registry };
}

export function encodeInstallationBootstrap(value: unknown, version: number): Uint8Array<ArrayBuffer> {
  dialect(version);
  const decoded = bootstrap(value);
  const output = new AgentPayloadWriter(16_384).bytes(encodeInstallationRequest(decoded.request, version));
  for (const credit of decoded.credits) output.bytes(encodeAssistanceCredit(credit, version));
  return output.string(decoded.registry).finish();
}

export function decodeInstallationBootstrap(bytes: Uint8Array, version: number): InstallationBootstrap {
  dialect(version);
  if (bytes.length > 16_384) invalid();
  const input = new AgentPayloadReader(bytes);
  const request = decodeInstallationRequest(input.bytes(), version);
  const credits = Array.from({ length: 4 }, () => decodeAssistanceCredit(input.bytes(), version));
  const registry = input.string();
  input.finish();
  const result = bootstrap({ request, credits, registry });
  const encoded = encodeInstallationBootstrap(result, version);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) invalid();
  return result;
}

/** First native stdout header, before length-prefixed registry traffic. A
 * private authenticated pipe supplies identity; no port header grants access. */
export function encodeInstallationGatewayReady(value: unknown): Uint8Array<ArrayBuffer> {
  const port = integer(value, "installation gateway port", 1, 65535);
  const bytes = new Uint8Array([79, 88, 73, 71, 0, 0, 0, 0]);
  new DataView(bytes.buffer).setUint32(4, port, true);
  return bytes;
}

export function decodeInstallationGatewayReady(bytes: Uint8Array): number {
  if (bytes.length !== 8 || bytes[0] !== 79 || bytes[1] !== 88 || bytes[2] !== 73 || bytes[3] !== 71) invalid();
  return integer(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true), "installation gateway port", 1, 65535);
}

/** Guest dispatcher bounds, mirrored from the agent's assistance protocol:
 * the pipe queues one window per direction, each publication capture source
 * keeps one read window, and the dispatcher lanes hold exactly those. Control
 * never issues more concurrent data exchanges than the lanes admit. */
export const INSTALLATION_PIPE_WINDOW = 4;
export const CAPTURE_WINDOW = 4;
export const INSTALLATION_DATA_LANE = 2 * INSTALLATION_PIPE_WINDOW;
export const CAPTURE_DATA_LANE = 3 * CAPTURE_WINDOW;
/** Guest pipe credit, mirrored from the agent's assistance protocol: the
 * fixed lifetime overhead the pipe reserves when it opens, then what each
 * queued 64 KiB read and write retains until acknowledged. */
export const INSTALLATION_PIPE_FIXED_BYTES = 2 * 1024 * 1024;
export const INSTALLATION_PIPE_READ_BYTES = 64 * 1024 * 4 + 1024;
export const INSTALLATION_PIPE_WRITE_BYTES = 64 * 1024 * 2 + 1024;
/** The installation data grant control issues (the guest validates the same value). */
export const INSTALLATION_DATA_GRANT_BYTES = 11 * 256 * 1024;
/** Writes control keeps in flight beside its one blocking read: derived from
 * the grant so a pipelined write is never refused for credit. */
export const INSTALLATION_WRITE_WINDOW = Math.min(INSTALLATION_PIPE_WINDOW,
  Math.floor(Math.max(0, INSTALLATION_DATA_GRANT_BYTES - INSTALLATION_PIPE_FIXED_BYTES - INSTALLATION_PIPE_READ_BYTES) / INSTALLATION_PIPE_WRITE_BYTES));
