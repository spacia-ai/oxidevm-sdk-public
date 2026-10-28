import { validateWorkspaceMetadata, type FileOwnership } from "./workspace-record.js";
import { VMError } from "./errors.js";
import { TextDecoder, TextEncoder } from "./web-encoding.js";
import { AgentFragments, AGENT_FRAGMENT_KIND, AGENT_FRAGMENT_BYTES, AGENT_FRAGMENT_HEADER } from "./agent-fragments.js";

// Readiness selects the exact guest dialect before hello.
export const AGENT_PROTOCOL_VERSION = 7;
export type AgentProtocolVersion = 3 | 4 | 5 | 6 | 7;
export const AGENT_HEADER_BYTES = 20;
export const MAX_AGENT_PAYLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_AGENT_TASK_PAYLOAD_BYTES = 128 * 1024;
export const AGENT_RESPONSE_BIT = 0x8000;

export const AgentKind = {
  guestSpawn: 34,
  hello: 1,
  readFile: 2,
  writeFile: 3,
  listDirectory: 4,
  remove: 5,
  spawn: 6,
  stdin: 7,
  signal: 8,
  closeStdin: 9,
  workspaceManifest: 10,
  applyWorkspace: 11,
  applyWorkspaceDelta: 12,
  workspaceDelta: 13,
  assistance: 14,
  assistanceVm: 16,
  assistanceCredit: 17,
  installationStart: 18,
  installationIo: 19,
  workspaceRestore: 20,
  workspaceCapture: 21,
  /** Resume operations; a guest 7 agent answers them only when it advertises `resume`. */
  setTime: 22,
  reseedEntropy: 23,
  listProcesses: 24,
  /** Listening-port reports (ADR 0015); a guest 7 agent answers them only when it advertises `listeners`. */
  watchListeners: 25,
  entries: 26,
  statEntry: 27,
  readEntry: 28,
  writeEntry: 29,
  createDirectory: 30,
  renameEntry: 31,
  watchEntries: 32,
  processControl: 33,
  captureProgress: 0x108,
  stdout: 0x100,
  stderr: 0x101,
  exit: 0x102,
  ready: 0x103,
  assistanceEvent: 0x104,
  installationEvent: 0x105,
  listeners: 0x106,
  entriesChanged: 0x107,
  workspaceCaptureProgress: 0x109,
} as const;

/** HELLO capability bits. */
export const AgentCapability = {
  files: 1,
  processes: 2,
  assistance: 8,
  fork: 16,
  /** Guest 7 agents that set time, reseed entropy and list processes for a resumed host. */
  resume: 32,
  /** Guest 7 agents that report listening ports (ADR 0015). */
  listeners: 64,
  files2: 128,
  processControl: 256,
  captureProgress: 512,
  workspaceTimes: 1024,
  /** Guest 7 agents that preserve OXRF7/OXWD3 inode metadata and FIFOs. */
  workspaceMetadata: 4096,
  /** Guest 7 agents that preserve character-device-zero whiteouts. */
  workspaceWhiteouts: 8192,
  /** Guest 7 agents that report schema-1 completed native capture entry counts. */
  workspaceCaptureProgress: 2048,
} as const;

export const AGENT_RESEED_BYTES = 64;

/** Includes the retired hotplug bit; later capabilities are exclusive to dialect seven. */
export function requireKnownAgentCapabilities(capabilities: number, dialect: AgentProtocolVersion | null | undefined): void {
  const known = dialect === 7 ? 16383 : dialect === 4 || dialect === 5 || dialect === 6 ? 15 : dialect === 3 ? 7 : 0;
  if ((capabilities & ~known) !== 0) throw new VMError("PROTOCOL_ERROR", `guest agent advertised unknown capabilities 0x${capabilities.toString(16)}`);
}

/** A process a guest agent started and still runs, from a listProcesses reply. */
export interface AgentListedProcess {
  readonly pid: number;
  /** The spawn request whose output frames the process sends. */
  readonly requestId: number;
  readonly terminal: boolean;
  readonly stdinOpen: boolean;
}

export type AgentWorkspaceManifestEntry =
  | AgentWorkspaceManifestNode<"file">
  | AgentWorkspaceManifestNode<"directory">
  | AgentWorkspaceManifestNode<"fifo">
  | AgentWorkspaceManifestNode<"whiteout">
  | (AgentWorkspaceManifestNode<"symlink"> & { readonly target: string });

interface AgentWorkspaceManifestNode<Kind extends "file" | "directory" | "symlink" | "fifo" | "whiteout"> {
  readonly ownership?: FileOwnership;
  readonly metadata?: Uint8Array<ArrayBuffer>;
  readonly kind: Kind;
  readonly mode: number;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly path: string;
}

export interface AgentFrame {
  readonly version: AgentProtocolVersion;
  readonly kind: number;
  readonly requestId: number;
  readonly status: number;
  readonly payload: Uint8Array<ArrayBuffer>;
}

const magic = new Uint8Array([0x4f, 0x58, 0x47, 0x41]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeAgentFrame(frame: Omit<AgentFrame, "version"> & { readonly version?: AgentProtocolVersion }): Uint8Array<ArrayBuffer> {
  const version = agentDialect(frame.version ?? AGENT_PROTOCOL_VERSION);
  validateInteger(frame.kind, "kind", 1, 0xffff);
  validateInteger(frame.requestId, "request id", 1, 0xffff_ffff);
  validateInteger(frame.status, "status", 0, 0xffff_ffff);
  if (frame.payload.byteLength > framePayloadLimit(version, frame.kind)) {
    fail("agent frame payload is too large");
  }
  const encoded = new Uint8Array(AGENT_HEADER_BYTES + frame.payload.byteLength);
  encoded.set(magic);
  const view = new DataView(encoded.buffer);
  view.setUint16(4, version, true);
  view.setUint16(6, frame.kind, true);
  view.setUint32(8, frame.requestId, true);
  view.setUint32(12, frame.payload.byteLength, true);
  view.setUint32(16, frame.status, true);
  encoded.set(frame.payload, AGENT_HEADER_BYTES);
  return encoded;
}

/** A setTime payload: the host wall clock as Unix seconds (i64) and nanoseconds (u32). */
export function encodeAgentSetTime(unixMilliseconds: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(unixMilliseconds) || unixMilliseconds < 0) fail("invalid agent wall-clock time");
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setBigInt64(0, BigInt(Math.floor(unixMilliseconds / 1_000)), true);
  view.setUint32(8, (unixMilliseconds % 1_000) * 1_000_000, true);
  return payload;
}

/** A reseedEntropy payload: exactly AGENT_RESEED_BYTES host random bytes. */
export function encodeAgentReseed(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.byteLength !== AGENT_RESEED_BYTES) fail("an entropy reseed takes exactly 64 bytes");
  return bytes.slice();
}

/**
 * A listProcesses reply: a count, then per process its pid, spawn request id and flags (bit 0
 * terminal, bit 1 stdin open), ordered by pid.
 */
export function decodeAgentProcessList(payload: Uint8Array): AgentListedProcess[] {
  if (payload.byteLength < 4) fail("guest process list is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint32(0, true);
  if (payload.byteLength !== 4 + count * 9) fail("guest process list has the wrong length");
  const processes: AgentListedProcess[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * 9;
    const pid = view.getUint32(offset, true);
    const flags = view.getUint8(offset + 8);
    const previous = processes.at(-1);
    if (pid === 0 || (flags & ~0b11) !== 0 || (previous !== undefined && pid <= previous.pid)) {
      fail("guest process list entry is invalid");
    }
    processes.push({
      pid,
      requestId: view.getUint32(offset + 4, true),
      terminal: (flags & 1) !== 0,
      stdinOpen: (flags & 2) !== 0,
    });
  }
  return processes;
}

/** Bytes a resumed decoder replays; past this, the stream cannot continue across a restore. */
const MAX_RESUME_REPLAY_BYTES = 1024 * 1024;

export class AgentFrameDecoder {
  #pending: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  readonly #fragments = new AgentFragments();
  /** Bytes pushed since the decoder was last idle at the start of a push, and their frames. */
  #replay: { chunks: Uint8Array[]; bytes: number; frames: number } | undefined = { chunks: [], bytes: 0, frames: 0 };

  /**
   * A decoder in the state `bytes` leave a fresh one in, without the first `skip` frames they
   * complete, which the decoder that recorded them already delivered.
   */
  static resume(bytes: Uint8Array, skip: number): AgentFrameDecoder {
    const decoder = new AgentFrameDecoder();
    if (decoder.push(bytes).length !== skip) fail("the agent stream replay does not match its record");
    return decoder;
  }

  /**
   * What a resumed decoder replays to continue this stream: the bytes since this decoder was
   * last idle and how many frames they completed; undefined when that exceeded 1 MiB.
   */
  resumeInbound(): { readonly bytes: Uint8Array<ArrayBuffer>; readonly skip: number } | undefined {
    const replay = this.#replay;
    if (replay === undefined) return undefined;
    const bytes = new Uint8Array(replay.bytes);
    let offset = 0;
    for (const chunk of replay.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, skip: replay.frames };
  }

  /** Whether the decoder holds no partial frame and no fragment reassembly. */
  get idle(): boolean {
    return this.#pending.byteLength === 0 && this.#fragments.idle;
  }

  push(chunk: Uint8Array): AgentFrame[] {
    if (chunk.byteLength === 0) return [];
    if (this.idle) {
      this.#replay = { chunks: [], bytes: 0, frames: 0 };
    }
    if (this.#replay !== undefined) {
      this.#replay.bytes += chunk.byteLength;
      this.#replay.chunks.push(chunk.slice());
      if (this.#replay.bytes > MAX_RESUME_REPLAY_BYTES) this.#replay = undefined;
    }
    const pending = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
    pending.set(this.#pending);
    pending.set(chunk, this.#pending.byteLength);
    this.#pending = pending;

    const frames: AgentFrame[] = [];
    let offset = 0;
    while (this.#pending.byteLength - offset >= AGENT_HEADER_BYTES) {
      for (let index = 0; index < magic.byteLength; index += 1) {
        if (this.#pending[offset + index] !== magic[index]) {
          fail("invalid agent frame magic");
        }
      }
      const view = new DataView(
        this.#pending.buffer,
        this.#pending.byteOffset + offset,
        AGENT_HEADER_BYTES,
      );
      const version = view.getUint16(4, true);
      if (version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7) {
        fail(
          `unsupported agent protocol version ${String(version)} in header ${hex(
            this.#pending.subarray(offset, offset + AGENT_HEADER_BYTES),
          )}`,
        );
      }
      const kind = view.getUint16(6, true);
      if (kind === 0) fail("invalid agent frame kind");
      const length = view.getUint32(12, true);
      if (length > framePayloadLimit(version, kind)) {
        fail("agent frame payload is too large");
      }
      const frameBytes = AGENT_HEADER_BYTES + length;
      if (this.#pending.byteLength - offset < frameBytes) break;
      const frame = this.#fragments.accept({
        version,
        kind,
        requestId: view.getUint32(8, true),
        status: view.getUint32(16, true),
        payload: this.#pending.slice(
          offset + AGENT_HEADER_BYTES,
          offset + frameBytes,
        ),
      });
      if (frame !== undefined) frames.push(frame);
      offset += frameBytes;
    }
    if (offset !== 0) this.#pending = this.#pending.slice(offset);
    if (this.#replay !== undefined) this.#replay.frames += frames.length;
    return frames;
  }

  finish(): void {
    if (this.#pending.byteLength !== 0) fail("truncated agent frame");
    this.#fragments.finish();
  }
}

function framePayloadLimit(version: AgentProtocolVersion, kind: number): number {
  if (version === 5 || version === 6 || version === 7) return kind === AGENT_FRAGMENT_KIND ? AGENT_FRAGMENT_BYTES + AGENT_FRAGMENT_HEADER : AGENT_FRAGMENT_BYTES;
  if (version === 4 && kind === AGENT_FRAGMENT_KIND) return AGENT_FRAGMENT_BYTES + AGENT_FRAGMENT_HEADER;
  const operation = kind & ~AGENT_RESPONSE_BIT;
  return version === 4 && (operation === AgentKind.assistance || operation === AgentKind.assistanceEvent) ? MAX_AGENT_TASK_PAYLOAD_BYTES : MAX_AGENT_PAYLOAD_BYTES;
}

function agentDialect(value: unknown): AgentProtocolVersion {
  if (value !== 3 && value !== 4 && value !== 5 && value !== 6 && value !== 7) fail("unsupported agent protocol version");
  return value;
}

export class AgentPayloadWriter {
  readonly #parts: Uint8Array[] = [];
  #length = 0;

  private readonly maximumBytes: number;
  constructor(maximumBytes = MAX_AGENT_PAYLOAD_BYTES) {
    this.maximumBytes = maximumBytes;
    validateInteger(maximumBytes, "payload limit", 0, MAX_AGENT_PAYLOAD_BYTES);
  }

  u8(value: number): this {
    validateInteger(value, "payload byte", 0, 0xff);
    return this.bytesRaw(new Uint8Array([value]));
  }

  u32(value: number): this {
    validateInteger(value, "payload integer", 0, 0xffff_ffff);
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return this.bytesRaw(bytes);
  }

  u64(value: bigint): this {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      fail("payload unsigned integer is outside u64");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return this.bytesRaw(bytes);
  }

  i64(value: bigint): this {
    if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) {
      fail("payload signed integer is outside i64");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    return this.bytesRaw(bytes);
  }

  bytes(value: Uint8Array): this {
    this.u32(value.byteLength);
    return this.bytesRaw(value);
  }

  string(value: string): this {
    return this.bytes(encoder.encode(value));
  }

  finish(): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(this.#length);
    let offset = 0;
    for (const part of this.#parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }

  bytesRaw(value: Uint8Array): this {
    if (this.#length + value.byteLength > this.maximumBytes) {
      fail("agent payload is too large");
    }
    this.#parts.push(value);
    this.#length += value.byteLength;
    return this;
  }
}

export class AgentPayloadReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  u8(): number {
    const byte = this.#bytes[this.#offset];
    if (byte === undefined) fail("truncated agent payload");
    this.#offset += 1;
    return byte;
  }

  u32(): number {
    const bytes = this.take(4);
    return new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(0, true);
  }

  i32(): number {
    const bytes = this.take(4);
    return new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getInt32(0, true);
  }

  u64(): bigint {
    const bytes = this.take(8);
    return new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigUint64(0, true);
  }

  i64(): bigint {
    const bytes = this.take(8);
    return new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigInt64(0, true);
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return this.take(this.u32()).slice();
  }

  string(): string {
    try {
      return decoder.decode(this.bytes());
    } catch {
      fail("agent payload contains invalid UTF-8");
    }
  }

  finish(): void {
    if (this.#offset !== this.#bytes.byteLength) {
      fail("agent payload has trailing bytes");
    }
  }

  take(length: number): Uint8Array {
    const end = this.#offset + length;
    if (!Number.isSafeInteger(end) || end > this.#bytes.byteLength) {
      fail("truncated agent payload");
    }
    const value = this.#bytes.subarray(this.#offset, end);
    this.#offset = end;
    return value;
  }
}

export function decodeAgentWorkspaceManifest(
  bytes: Uint8Array,
): AgentWorkspaceManifestEntry[] {
  const owned = new TextDecoder().decode(bytes.subarray(0, 4)) === "OXWM";
  if (bytes.length > MAX_AGENT_PAYLOAD_BYTES || owned && (bytes.length < 8 || (bytes[4] !== 1 && bytes[4] !== 2 && bytes[4] !== 3)
    || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0)) fail("Invalid workspace manifest version");
  const rich = owned && (bytes[4] === 2 || bytes[4] === 3);
  const payload = new AgentPayloadReader(owned ? bytes.subarray(8) : bytes);
  const count = payload.u32();
  if (count > 1_000_000) fail("guest workspace manifest is too large");
  const entries: AgentWorkspaceManifestEntry[] = [];
  const paths = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const rawKind = payload.u8();
    const kind = rawKind === 1
      ? "directory"
      : rawKind === 2
        ? "file"
        : rawKind === 3
          ? "symlink"
          : rich && rawKind === 4 ? "fifo" : owned && bytes[4] === 3 && rawKind === 5 ? "whiteout" : undefined;
    if (kind === undefined) fail("guest workspace manifest kind is invalid");
    const mode = payload.u32();
    if (mode > 0o7777) fail("guest workspace manifest mode is invalid");
    const ownership = owned ? { uid: payload.u32(), gid: payload.u32() } : undefined;
    if (ownership?.uid === 0xffff_ffff || ownership?.gid === 0xffff_ffff) fail("Invalid workspace ownership");
    const node = {
      ...(ownership === undefined ? {} : { ownership }),
      kind,
      mode,
      size: payload.u64(),
      mtimeNs: payload.i64(),
      ctimeNs: payload.i64(),
      device: payload.u64(),
      inode: payload.u64(),
      path: payload.string(),
    };
    validateWorkspaceManifestPath(node.path, paths, owned && kind === "directory");
    paths.add(node.path);
    const target = kind === "symlink" ? payload.string() : undefined;
    const metadata = rich ? payload.bytes() : undefined;
    if (metadata !== undefined) validateWorkspaceMetadata(metadata);
    if (kind === "symlink" && target !== undefined) {
      if (target.length === 0 || target.includes("\0")) {
        fail("guest workspace symlink target is invalid");
      }
      entries.push({ ...node, kind, target, ...(metadata === undefined ? {} : { metadata }) });
    } else {
      if ((kind === "fifo" || kind === "whiteout") && node.size !== 0n) fail("Invalid special workspace inode size");
      if (kind === "symlink") fail("Invalid workspace symlink target");
      entries.push({ ...node, kind, ...(metadata === undefined ? {} : { metadata }) });
    }
  }
  payload.finish();
  return entries;
}

function validateWorkspaceManifestPath(path: string, paths: ReadonlySet<string>, allowRoot = false): void {
  if (
    !(allowRoot && path === "/workspace") && !path.startsWith("/workspace/")
    || paths.has(path)
    || path.includes("\0")
    || path.split("/").some((part) => part === "." || part === "..")
  ) {
    fail("guest workspace manifest path is invalid");
  }
}

function validateInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`invalid agent ${label}`);
  }
}

function fail(message: string): never {
  throw new VMError("PROTOCOL_ERROR", message);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
