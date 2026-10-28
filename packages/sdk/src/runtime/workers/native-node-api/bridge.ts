import type { FileDescriptor, LinuxSyncFiles } from "../../../js-process-types.js";
import { descriptor, protocol, Reader, viewBytes, writeBytes, type LinuxOperation } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import { integer } from "../../decode.js";
import { decodeNativeFrame, encodeNativeFrame, NATIVE_MAX_FRAME, type NativeFrame } from "./codec.js";
import { NativeValues } from "./values.js";
import { decodeNativeMetadata, encodeNativeString } from "./strings.js";
import { nativeMapSize, nativeSetSize } from "./collection-size.js";

const min = Math.min;
const arrayFrom = Array.from;
const Number = globalThis.Number, BigInt = globalThis.BigInt, Uint8Array = globalThis.Uint8Array;

type NativeInvocation = "load" | "call" | "finalize" | "claim-callback" | "retire-callback" | "release-buffer"
  | "cleanup" | "finalize-environments" | "retire-environment" | "create-environment" | "raise-signal";
type NativeClient = { call<T>(operation: LinuxOperation<T>, signal?: AbortSignal): Promise<T> };
type PendingInvocation = { readonly operation: NativeInvocation; completion: NativeFrame | undefined };
const pending = new Set<bigint>(), references = new Map<bigint, boolean>(), loading = new Map<bigint, string>(), invocations = new Map<number, PendingInvocation>(), apply = Reflect.apply;
const pendingHas = Reflect.get(pending, "has"), pendingAdd = Reflect.get(pending, "add"), pendingDelete = Reflect.get(pending, "delete");
const referenceHas = Reflect.get(references, "has"), referenceSet = Reflect.get(references, "set"), referenceDelete = Reflect.get(references, "delete"), referenceValues = Reflect.get(references, "values");
const referenceNext = Reflect.get(apply(referenceValues, references, []), "next");
const loadingGet = Reflect.get(loading, "get"), loadingSet = Reflect.get(loading, "set"), loadingDelete = Reflect.get(loading, "delete");
const invocationGet = Reflect.get(invocations, "get"), invocationSet = Reflect.get(invocations, "set"), invocationDelete = Reflect.get(invocations, "delete");

export interface NativeTransportEvent {
  readonly sequence: number;
  readonly operation: "read" | "write" | "readiness";
  readonly bytes: number;
  readonly milliseconds: number;
}

/** One process's synchronous re-entrant calls and asynchronous readiness pump. */
export class NativeBridge {
  readonly values: NativeValues;
  readonly #pending = new Set<bigint>();
  readonly #references = new Map<bigint, boolean>();
  readonly #loading = new Map<bigint, string>();
  readonly #invocations = new Map<number, PendingInvocation>();
  readonly #input: FileDescriptor;
  readonly #output: FileDescriptor;
  #sequence = 0;
  #nativeSequence = 0;
  #signalSequence = 0;
  #revision = 0;
  #closed = false;
  #watching: AbortController | undefined;
  #buffer: Uint8Array = new Uint8Array();
  #offset = 0;
  #failure: Error | undefined;
  #deliveringException: { readonly value: unknown } | undefined;
  constructor(readonly client: NativeClient, readonly files: Pick<LinuxSyncFiles, "read" | "writeAll">, input: number, output: number, readonly events: {
    changed(): void; failed(error: unknown): void; uncaught(error: unknown, deliver: (handler: () => void) => void): void; signal?(signal: 1 | 2 | 15): void; trace?(frame: NativeFrame): void; transport?(event: NativeTransportEvent): void; readonly environment?: number; readonly runtime?: "node" | "bun";
  }) {
    this.#input = descriptor(input); this.#output = descriptor(output);
    this.values = new NativeValues((callback, receiver, target, args) => this.#call("call", () => {
      const receiverId = this.values.add(receiver), targetId = target === undefined ? 0n : this.values.add(target), arrayLike = { __proto__: null, length: args.length + 3 };
      return arrayFrom(arrayLike, (_value, index) => index === 0 ? callback : index === 1 ? receiverId : index === 2 ? targetId : this.values.add(args[index - 3]));
    }), callback => { this.#call("finalize", () => [callback]); }, identity => { this.#call("release-buffer", () => [BigInt(identity)]); }, events.environment, error => { this.#uncaught(error); }, {
      runtime: events.runtime ?? "node",
      claim: (identity, environment) => { this.#call("claim-callback", () => [identity, environment]); },
      retire: identity => { this.#call("retire-callback", () => [identity]); },
    });
  }
  get pending(): number {
    let count = nativeSetSize(this.#pending);
    const iterator = apply(referenceValues, this.#references, []);
    for (let step = apply(referenceNext, iterator, []); step.done !== true; step = apply(referenceNext, iterator, [])) if (step.value) count++;
    return count;
  }
  #uncaught(error: unknown): void {
    this.events.uncaught(error, handler => {
      const previous = this.#deliveringException; this.#deliveringException = { value: error };
      try { handler(); } finally { this.#deliveringException = previous; }
    });
  }
  load(path: string): unknown { return this.#call("load", () => [this.values.add({})], encodeNativeString(path, "utf8")); }
  createEnvironment(channels: readonly number[]): number {
    return integer(this.#call("create-environment", () => {
      const arrayLike = { __proto__: null, length: channels.length };
      return arrayFrom(arrayLike, (_value, index) => BigInt(integer(channels[index], "native channel descriptor", 0, 0x7fff_ffff)));
    }), "native TID", 1, 0x7fff_ffff);
  }
  raiseSignal(signal: 1 | 2 | 9 | 15): void { this.#call("raise-signal", () => [BigInt(signal)]); }
  #readAll(count: number): Uint8Array<ArrayBuffer> {
    integer(count, "native read length", 0, NATIVE_MAX_FRAME);
    const result = new Uint8Array(count); let offset = 0;
    while (offset < count) {
      if (this.#offset === this.#buffer.byteLength) {
        const started = this.events.transport === undefined ? 0 : performance.now();
        this.#buffer = this.files.read(this.#input, 64 * 1024); this.#offset = 0;
        this.events.transport?.({ sequence: this.#sequence, operation: "read", bytes: this.#buffer.byteLength, milliseconds: performance.now() - started });
        if (this.#buffer.byteLength === 0) protocol("Native control descriptor reached EOF");
        if (this.#buffer.byteLength > 64 * 1024) protocol("Native control read exceeded its byte limit");
      }
      const take = min(count - offset, this.#buffer.byteLength - this.#offset);
      writeBytes(result, viewBytes(this.#buffer, this.#offset, this.#offset + take), offset);
      offset += take; this.#offset += take;
    }
    return result;
  }
  #bufferedFrame(): boolean {
    const available = this.#buffer.byteLength - this.#offset;
    if (available < 4) return false;
    const length = new Reader(viewBytes(this.#buffer, this.#offset, this.#offset + 4)).u32();
    return length < 48 || length > NATIVE_MAX_FRAME || available >= length + 4;
  }
  #read(): NativeFrame {
    const length = new Reader(this.#readAll(4)).u32();
    return decodeNativeFrame(this.#readAll(integer(length, "native frame length", 48, NATIVE_MAX_FRAME)));
  }
  #write(frame: NativeFrame): void {
    const bytes = encodeNativeFrame(frame), started = this.events.transport === undefined ? 0 : performance.now();
    this.files.writeAll(this.#output, bytes);
    this.events.transport?.({ sequence: frame.sequence, operation: "write", bytes: bytes.byteLength, milliseconds: performance.now() - started });
  }
  #service(frame: NativeFrame): void {
    this.events.trace?.(frame);
    if (frame.kind === 3) {
      if (frame.sequence !== this.#nativeSequence + 1 || frame.status !== 0) protocol("Stale native Node-API request");
      this.#nativeSequence = frame.sequence;
      const result = this.values.withScope(frame.scope, () => {
        if (frame.operation === "register-environment") {
          const path = decodeNativeMetadata(frame.bytes), version = frame.args[0];
          if (frame.environment === 0n || frame.args.length !== 1 || version === undefined || version < 8n || version > 10n || apply(loadingGet, this.#loading, [frame.scope]) !== path) protocol("Invalid native module registration");
          const runtime = this.values.registerEnvironment(frame.environment, Number(version)); apply(loadingDelete, this.#loading, [frame.scope]);
          return { status: 0, args: [0n, runtime === "bun" ? 1n : 0n], bytes: new Uint8Array() };
        }
        return this.values.withEnvironment(frame.environment, () => this.values.dispatch(frame.operation, frame.args, frame.bytes));
      });
      const reply = { ...frame, kind: 4, ...result };
      this.#write(reply); this.events.trace?.(reply);
    } else if (frame.kind === 6) {
      if (frame.operation !== "async-queued" || frame.args.length !== 1 || frame.args[0] !== BigInt(frame.sequence) || nativeSetSize(this.#pending) >= 128 || apply(pendingHas, this.#pending, [BigInt(frame.sequence)])) protocol("Invalid queued native work");
      if (frame.status !== 0 || frame.bytes.byteLength !== 0) protocol("Invalid queued native work payload");
      this.values.createScope(frame.scope); apply(pendingAdd, this.#pending, [BigInt(frame.sequence)]); this.events.changed();
    } else if (frame.kind === 5) {
      if (frame.operation !== "async-complete" || frame.args.length !== 1 || frame.args[0] !== BigInt(frame.sequence) || !apply(pendingDelete, this.#pending, [BigInt(frame.sequence)])) protocol("Stale native async completion");
      if (frame.status !== 0 || frame.bytes.byteLength !== 0) protocol("Invalid native completion payload");
      this.values.retireScope(frame.scope);
      try { this.values.throwPending(frame.scope); } catch (error) { this.#uncaught(error); }
      this.events.changed();
    } else if (frame.kind === 7) {
      const identity = BigInt(frame.sequence), state = frame.args[1];
      if (frame.operation !== "async-reference" || frame.args.length !== 2 || frame.args[0] !== identity || frame.status !== 0 || frame.bytes.byteLength !== 0 || state === undefined || state > 2n) protocol("Invalid native event-loop reference");
      if (state === 2n) { if (!apply(referenceDelete, this.#references, [identity])) protocol("Stale native event-loop reference"); }
      else { if (!apply(referenceHas, this.#references, [identity]) && (state !== 1n || nativeMapSize(this.#references) >= 128)) protocol("Invalid native reference admission"); apply(referenceSet, this.#references, [identity, state === 1n]); }
      this.events.changed();
    } else if (frame.kind === 8) {
      const signal = frame.args[0];
      if (frame.operation !== "signal" || frame.sequence <= this.#signalSequence || frame.args.length !== 1 || frame.status !== 0 || frame.bytes.byteLength !== 0 || (signal !== 1n && signal !== 2n && signal !== 15n) || this.events.signal === undefined) protocol("Invalid or stale native process signal");
      this.#signalSequence = frame.sequence; this.events.signal(signal === 1n ? 1 : signal === 2n ? 2 : 15);
    } else protocol("Unexpected native frame outside invocation");
  }
  #call(name: NativeInvocation, argumentsForScope: () => readonly bigint[], bytes = new Uint8Array()): unknown {
    if (this.#closed) protocol("Native process is retired");
    if (this.#failure !== undefined) throw this.#failure;
    // Pending application exceptions must still permit teardown and signal delivery.
    if (this.#deliveringException !== undefined && (name === "call" || name === "load" || name === "create-environment")) throw this.#deliveringException.value;
    if (nativeMapSize(this.#invocations) >= 64) protocol("Native invocation depth bound");
    const sequence = integer(++this.#sequence, "native invocation identity", 1, 0xffff_ffff); this.#revision++;
    this.#watching?.abort();
    const scope = BigInt(sequence); this.values.createScope(scope);
    const pending: PendingInvocation = { operation: name, completion: undefined }; apply(invocationSet, this.#invocations, [sequence, pending]);
    if (name === "load") apply(loadingSet, this.#loading, [scope, decodeNativeMetadata(bytes)]);
    try {
      let result: unknown;
      try {
        const invocation = { kind: 1, sequence, scope, environment: 0n, operation: name, status: 0, args: this.values.withScope(scope, argumentsForScope), bytes };
        this.events.trace?.(invocation);
        this.#write(invocation);
        for (;;) {
          if (pending.completion !== undefined) {
            const handle = pending.completion.args[0]; if (handle === undefined) protocol("Missing native result handle");
            result = handle === 0n ? undefined : this.values.get(handle); break;
          }
          const frame = this.#read();
          if (frame.kind !== 2) { this.#service(frame); continue; }
          this.events.trace?.(frame);
          const target = apply(invocationGet, this.#invocations, [frame.sequence]);
          if (target === undefined || target.completion !== undefined || frame.operation !== target.operation || frame.status !== 0 || frame.args.length !== 1 || frame.bytes.byteLength !== 0) protocol("Stale native invocation completion");
          target.completion = frame;
        }
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error("Native invocation failed", { cause: error });
        this.events.failed(this.#failure); throw this.#failure;
      }
      // Ownership acknowledgements do not enter JavaScript or consume its pending exception.
      if (name !== "claim-callback" && name !== "retire-callback") this.values.throwPending(scope);
      return result;
    } finally { apply(invocationDelete, this.#invocations, [sequence]); apply(loadingDelete, this.#loading, [scope]); this.values.retireScope(scope); }
  }
  watch(): void {
    if (this.#closed || this.#watching !== undefined || this.#failure !== undefined) return;
    const watcher = new AbortController(), revision = this.#revision;
    this.#watching = watcher;
    const poll = files.poll([{ fd: this.#input, events: 1 }]);
    let waiting = true;
    const buffered = this.#bufferedFrame(), started = this.events.transport === undefined ? 0 : performance.now(), sequence = this.#sequence;
    const ready = buffered ? Promise.resolve() : this.client.call(poll, watcher.signal).finally(() => {
      this.events.transport?.({ sequence, operation: "readiness", bytes: 0, milliseconds: performance.now() - started });
    });
    void ready.then(() => {
      waiting = false;
      if (this.#watching !== watcher) return;
      if (this.#closed) { this.#watching = undefined; return; }
      if (this.#revision === revision) {
        for (;;) { const frame = this.#read(); this.#service(frame); if (frame.kind === 5 || frame.kind === 7 || frame.kind === 8) break; }
      }
      this.#watching = undefined;
      this.watch();
    }).catch((error: unknown) => {
      if (this.#watching !== watcher) return;
      this.#watching = undefined; if (this.#closed) return;
      if (waiting && watcher.signal.aborted) { this.watch(); return; }
      this.#failure = error instanceof Error ? error : new Error("Native readiness failed", { cause: error }); this.events.failed(this.#failure);
    });
  }
  dispose(code = 0): void {
    integer(code, "native application exit code", 0, 255);
    if (this.#closed) return;
    this.#call("cleanup", () => []); this.values.finalizeResources();
    this.#call("finalize-environments", () => []); this.values.dispose();
    this.#call("retire-environment", () => [BigInt(code)]); this.#closed = true;
  }
}
