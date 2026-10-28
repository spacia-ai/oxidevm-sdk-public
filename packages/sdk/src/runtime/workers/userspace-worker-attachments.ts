import { VMError } from "../errors.js";
import { encodeNativeAttachments, type NativeAttachment, type NativeAttachments } from "./userspace-attachments.js";

/** Browser delivery state; unread output and terminal policy remain native-owned. */
export interface ProcessAttachmentState {
  readonly pid: number;
  readonly identityKey: number;
  readonly sessionId: number;
  readonly command: string;
  terminal: NativeAttachment["terminal"];
  stdinOpen: boolean;
  sequence: number;
  acknowledged: number;
  awaitingAck: { readonly sequence: number; readonly stream: "stdout" | "stderr"; readonly count: number } | undefined;
  tail: Uint8Array;
  stopped: boolean;
}
export interface PreparedWorkerAttachments { readonly attachments: NativeAttachments; publish(): void }

/** Owns browser handle identities and restored roots waiting for their new MessagePort. */
export class UserspaceWorkerAttachments {
  #next = 1;
  #pending = new Map<number, NativeAttachment>();
  get pendingCount(): number { return this.#pending.size; }
  allocate(): number {
    if (this.#next >= 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Native attachment identities are exhausted");
    return this.#next++;
  }
  capture(active: Iterable<ProcessAttachmentState>): Uint8Array<ArrayBuffer> {
    const processes = [...active].map(captureProcess);
    processes.push(...this.#pending.values());
    processes.sort((left, right) => left.identityKey - right.identityKey);
    return encodeNativeAttachments({ nextKey: this.#next, processes });
  }
  prepare(saved: NativeAttachments, recovering: boolean, active: Iterable<ProcessAttachmentState>,
    validate: (attachment: NativeAttachment) => NativeAttachment["terminal"]): PreparedWorkerAttachments {
    const current = new Map([...active].map(process => [process.pid, process]));
    // Validate the whole candidate before reserving any replacement handle identities.
    const checked = saved.processes.map(attachment => ({ ...attachment, terminal: validate(attachment) }));
    if (recovering) for (const attachment of checked) {
      const existing = current.get(attachment.pid);
      if (existing !== undefined && existing.sessionId !== attachment.key) invalid("Recovery attachment identity differs from its original handle");
    }
    this.#next = Math.max(this.#next, saved.nextKey);
    const processes: NativeAttachment[] = checked.map(attachment => recovering ? attachment : {
      key: this.allocate(), identityKey: attachment.identityKey, pid: attachment.pid, command: attachment.command, terminal: attachment.terminal,
      stdinOpen: attachment.stdinOpen, sequence: 0, acknowledged: 0, tail: attachment.tail,
    });
    const pending = new Map(processes.filter(attachment => !recovering || !current.has(attachment.pid)).map(attachment => [attachment.key, attachment]));
    const result = { nextKey: this.#next, processes };
    let published = false;
    return { attachments: result, publish: () => {
      if (published) invalid("Native attachment replacement was already published");
      published = true; this.#pending = pending;
    } };
  }
  adopt(key: number): NativeAttachment {
    const attachment = this.#pending.get(key);
    if (attachment === undefined) invalid("Native process attachment is stale or already adopted");
    this.#pending.delete(key); return attachment;
  }
  clear(): void { this.#pending.clear(); }
}
function captureProcess(process: ProcessAttachmentState): NativeAttachment {
  return { key: process.sessionId, identityKey: process.identityKey, pid: process.pid, command: process.command, terminal: process.terminal,
    stdinOpen: process.stdinOpen, sequence: process.sequence, acknowledged: process.acknowledged,
    ...(process.awaitingAck === undefined ? {} : { pending: { stream: process.awaitingAck.stream, count: process.awaitingAck.count } }), tail: process.tail };
}
function invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
