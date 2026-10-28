import { VMError } from "./errors.ts";
import type { AgentFrame } from "./agent-protocol.ts";

export const AGENT_FRAGMENT_KIND = 15;
export const AGENT_FRAGMENT_BYTES = 4096;
export const AGENT_FRAGMENT_HEADER = 20;
const ENVELOPE_LIMIT = 128 * 1024;
const LEGACY_LIMIT = 128 * 1024 * 1024;

function lane(version: number, kind: number, request: number): "assisted" | "legacy" | undefined {
  if ((kind === 0x104 || (version === 6 || version === 7) && kind === 0x105) ? request === 0 : (kind === 14 || kind === 0x800e || (version === 6 || version === 7) && (kind === 18 || kind === 19 || kind === 0x8012 || kind === 0x8013)) && request !== 0) return "assisted";
  const operation = kind & ~0x8000;
  if ((version === 5 || version === 6 || version === 7) && request !== 0 && ((operation >= 1 && operation <= 13) || (version === 7 && operation >= 20 && operation <= 32) || (kind >= 0x100 && kind <= 0x102) || (version === 7 && (kind === 0x106 || kind === 0x107)))) return "legacy";
  return undefined;
}
function fail(): never { throw new VMError("PROTOCOL_ERROR", "Invalid assisted frame fragment"); }
function limit(kind: number, channel: "assisted" | "legacy"): number {
  return (kind & ~0x8000) === 21 ? 65_536 : (kind & ~0x8000) === 20 ? 53 + 65_536 : channel === "assisted" ? ENVELOPE_LIMIT : LEGACY_LIMIT;
}

type Reassembly = { readonly sequence: number; readonly frame: AgentFrame; offset: number };
/** v4 retains its single assisted transfer. v5 adds one independent legacy
 * transfer so workspace bulk traffic cannot occupy assisted reassembly. */
export class AgentFragments {
  #sequence = 0;
  readonly #active: { assisted?: Reassembly; legacy?: Reassembly } = {};

  accept(frame: AgentFrame): AgentFrame | undefined {
    if (frame.kind !== AGENT_FRAGMENT_KIND) return frame;
    const bytes = frame.payload;
    if ((frame.version !== 4 && frame.version !== 5 && frame.version !== 6 && frame.version !== 7) || frame.status !== 0 || frame.requestId === 0
      || bytes.length <= AGENT_FRAGMENT_HEADER || bytes.length > AGENT_FRAGMENT_HEADER + AGENT_FRAGMENT_BYTES) fail();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = view.getUint16(0, true);
    const requestId = view.getUint32(4, true);
    const status = view.getUint32(8, true);
    const length = view.getUint32(12, true);
    const offset = view.getUint32(16, true);
    const channel = lane(frame.version, kind, requestId);
    if (view.getUint16(2, true) !== 0 || channel === undefined || length === 0
      || length > limit(kind, channel)) fail();
    if (Object.values(this.#active).some(active => active.frame.version !== frame.version)) fail();
    let active = this.#active[channel];
    if (active === undefined) {
      if (offset !== 0 || frame.requestId <= this.#sequence) fail();
      this.#sequence = frame.requestId;
      active = { sequence: frame.requestId, offset: 0,
        frame: { version: frame.version, kind, requestId, status, payload: new Uint8Array(length) } };
      this.#active[channel] = active;
    }
    if (frame.requestId !== active.sequence || offset !== active.offset || kind !== active.frame.kind
      || frame.version !== active.frame.version || requestId !== active.frame.requestId || status !== active.frame.status || length !== active.frame.payload.length
      || bytes.length - AGENT_FRAGMENT_HEADER > length - offset) fail();
    active.frame.payload.set(bytes.subarray(AGENT_FRAGMENT_HEADER), offset);
    active.offset += bytes.length - AGENT_FRAGMENT_HEADER;
    if (active.offset !== length) return undefined;
    if (channel === "assisted") delete this.#active.assisted;
    else delete this.#active.legacy;
    return active.frame;
  }

  finish(): void { if (!this.idle) fail(); }

  /** Whether no fragmented frame is part way through reassembly. */
  get idle(): boolean { return this.#active.assisted === undefined && this.#active.legacy === undefined; }
}

/** Each sender owns this sequence independently of logical request identities. */
export class AgentFragmentSender {
  #sequence = 0;
  *frames(frame: AgentFrame): Generator<AgentFrame> {
    const channel = lane(frame.version, frame.kind, frame.requestId);
    if ((frame.version !== 4 && frame.version !== 5 && frame.version !== 6 && frame.version !== 7) || channel === undefined || frame.payload.length <= AGENT_FRAGMENT_BYTES) {
      yield frame; return;
    }
    if (frame.payload.length > limit(frame.kind, channel) || this.#sequence === 0xffff_ffff) fail();
    yield* agentFragments(frame, ++this.#sequence);
  }

  /** The last transfer sequence sent; the receiver refuses a new transfer that is not higher. */
  get sequence(): number { return this.#sequence; }

  /** Continues after transfer `sequence`, as a restored receiver last saw it. */
  continueFrom(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < this.#sequence || sequence > 0xffff_ffff) fail();
    this.#sequence = sequence;
  }
}

/** The fragment frames of `frame` as transfer `sequence` sends them. */
export function* agentFragments(frame: AgentFrame, sequence: number): Generator<AgentFrame> {
  for (let offset = 0; offset < frame.payload.length; offset += AGENT_FRAGMENT_BYTES) {
    const data = frame.payload.subarray(offset, offset + AGENT_FRAGMENT_BYTES);
    const payload = new Uint8Array(AGENT_FRAGMENT_HEADER + data.length);
    const view = new DataView(payload.buffer);
    view.setUint16(0, frame.kind, true);
    view.setUint32(4, frame.requestId, true);
    view.setUint32(8, frame.status, true);
    view.setUint32(12, frame.payload.length, true);
    view.setUint32(16, offset, true);
    payload.set(data, AGENT_FRAGMENT_HEADER);
    yield { version: frame.version, kind: AGENT_FRAGMENT_KIND, requestId: sequence, status: 0, payload };
  }
}
