import { AGENT_FRAGMENT_KIND, AgentFragmentSender, agentFragments } from "../../agent-fragments.js";
import { AgentKind, encodeAgentFrame, type AgentFrame } from "../../agent-protocol.js";
import { VMError } from "../../errors.js";
import { decodeAssistanceRequest, isAssistanceSupervisoryOperation } from "../../protocol/assistance.js";
import { decodeAssistanceCredit } from "../../protocol/assistance-credit.js";
import { decodeAssistanceVmRequest } from "../../protocol/assistance-vm.js";

import { decodeInstallationRequest, isInstallationSupervisoryOperation } from "../../protocol/assistance-installation.js";

type Lane = "legacy" | "assisted" | "control";
type Queued = {
  readonly frame: AgentFrame;
  readonly parts: Generator<AgentFrame>;
  readonly charge: number;
  /** Wire frames already handed to the device, and the fragment transfer they belong to. */
  taken: number;
  sequence: number | undefined;
};
const CAPACITY = 16 * 1024 * 1024 + 20;
const CONTROL = 1024 * 1024;
/**
 * The most host→guest bytes a restored session can owe the guest (`resumeOutbound`): the wire
 * bytes of queued frames, which the queue's capacity bounds.
 */
export const MAX_RESUME_OUTBOUND_BYTES = CAPACITY;

/** Frame-aware hvc1 input. One active transfer per data lane; wire frames are
 * never interleaved internally, including after a partial device write. */
export class AgentInput {
  readonly #sender = new AgentFragmentSender();
  readonly #queues: Record<Lane, Queued[]> = { legacy: [], assisted: [], control: [] };
  readonly #used: Record<Lane, number> = { legacy: 0, assisted: 0, control: 0 };
  #wire: { readonly bytes: Uint8Array<ArrayBuffer>; offset: number } | undefined;
  #entries = 0;

  get hasPending(): boolean { return this.#entries !== 0 || this.#wire !== undefined; }

  clear(): void {
    for (const lane of ["control", "assisted", "legacy"] as const) {
      this.#queues[lane].length = 0;
      this.#used[lane] = 0;
    }
    this.#wire = undefined;
    this.#entries = 0;
  }

  enqueue(frame: AgentFrame): void {
    const assistanceBounded = frame.version === 5 || frame.version === 6 || frame.version === 7;
    const bounded = assistanceBounded;
    const assisted = assistanceBounded && frame.kind === AgentKind.assistance;
    const installation = (frame.version === 6 || frame.version === 7) && frame.kind === AgentKind.installationIo;
    const installationControl = installation && isInstallationSupervisoryOperation(decodeInstallationRequest(frame.payload, frame.version).operation);
    const vm = assistanceBounded && frame.kind === AgentKind.assistanceVm;
    if (vm) decodeAssistanceVmRequest(frame.payload);
    const credit = assistanceBounded && frame.kind === AgentKind.assistanceCredit;
    if (credit) decodeAssistanceCredit(frame.payload, frame.version);
    const supervisory = vm || credit || installationControl || (assisted && frame.payload.length <= 4096
      && isAssistanceSupervisoryOperation(decodeAssistanceRequest(frame.payload).operation));
    const lane: Lane = supervisory ? "control" : assisted || installation ? "assisted" : "legacy";
    const fragmented = frame.version >= 4 && (frame.kind === 14 || bounded) && frame.payload.length > 4096;
    const charge = frame.payload.length + (fragmented ? Math.ceil(frame.payload.length / 4096) * 40 : 20);
    const used = lane === "control" ? this.#used.control : this.#used.legacy + this.#used.assisted;
    const limit = lane === "control" ? CONTROL : bounded ? CAPACITY - CONTROL : CAPACITY;
    const entries = bounded ? lane === "control" ? 128 : 127 : 1024;
    if (this.#entries >= entries || charge > limit - used) {
      throw new VMError("QUOTA_EXCEEDED", "pending guest agent input exceeds its protocol limit");
    }
    this.#used[lane] += charge;
    this.#entries += 1;
    this.#queues[lane].push({ frame, parts: this.#sender.frames(frame), charge, taken: 0, sequence: undefined });
  }

  /**
   * The host→guest bytes that complete every frame the guest has partly received: the rest of
   * the wire frame in flight and every unsent fragment of a started transfer. Frames not yet
   * started are left out; their requests end with the session. The live queue is unchanged.
   */
  resumeOutbound(): { readonly remainder: Uint8Array<ArrayBuffer>; readonly sequence: number } {
    const parts: Uint8Array[] = [];
    if (this.#wire !== undefined) parts.push(this.#wire.bytes.subarray(this.#wire.offset));
    for (const lane of ["control", "assisted", "legacy"] as const) {
      const head = this.#queues[lane][0];
      if (head === undefined || head.taken === 0 || head.sequence === undefined) continue;
      let index = 0;
      for (const part of agentFragments(head.frame, head.sequence)) {
        if (index >= head.taken) parts.push(encodeAgentFrame(part));
        index += 1;
      }
    }
    const remainder = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      remainder.set(part, offset);
      offset += part.byteLength;
    }
    return { remainder, sequence: this.#sender.sequence };
  }

  /** Starts a restored session: `remainder` goes out first, then frames after transfer `sequence`. */
  resume(remainder: Uint8Array, sequence: number): void {
    this.clear();
    this.#sender.continueFrom(sequence);
    if (remainder.byteLength !== 0) this.#wire = { bytes: remainder.slice(), offset: 0 };
  }

  flush(write: (bytes: Uint8Array<ArrayBuffer>) => number): void {
    for (;;) {
      if (this.#wire === undefined) {
        const bytes = this.#next();
        if (bytes === undefined) return;
        this.#wire = { bytes, offset: 0 };
      }
      const wire = this.#wire;
      const bytes = wire.bytes.subarray(wire.offset, wire.offset + 65536);
      const accepted = write(bytes);
      if (!Number.isInteger(accepted) || accepted < 0 || accepted > bytes.length) {
        throw new VMError("VM_FAULT", "guest agent console accepted an invalid byte count");
      }
      if (accepted === 0) return;
      wire.offset += accepted;
      if (wire.offset === wire.bytes.length) this.#wire = undefined;
    }
  }

  #next(): Uint8Array<ArrayBuffer> | undefined {
    for (const lane of ["control", "assisted", "legacy"] as const) {
      for (;;) {
        const queued = this.#queues[lane][0];
        if (queued === undefined) break;
        const part = queued.parts.next();
        if (part.done !== true) {
          queued.taken += 1;
          if (part.value.kind === AGENT_FRAGMENT_KIND) queued.sequence = part.value.requestId;
          return encodeAgentFrame(part.value);
        }
        this.#queues[lane].shift();
        this.#used[lane] -= queued.charge;
        this.#entries -= 1;
      }
    }
    return undefined;
  }
}
