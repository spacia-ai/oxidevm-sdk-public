import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeAssistanceBinding, type AssistanceBinding } from "../protocol/assistance.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { decodeWorkspaceTransfer, type WorkspaceTransferDescriptor } from "../protocol/workspace-publication.js";
import type { AssistanceTraffic } from "./control/assistance-traffic.js";
import type { WorkspaceStreamInput, WorkspaceStreamProducer } from "./workspace-stream.js";

type Receipt = "retire" | "retired" | "acknowledged" | "failed";
const RETIREMENT_MS = 30_000;

/** Web Streams carry data; EOF is deliberately independent of native retirement.
 * The existing VM budget owns every reservation until the receiver's final ACK. */
export function transferWorkspaceStream(input: WorkspaceStreamInput, binding: AssistanceBinding,
  transfer: number, traffic: AssistanceTraffic): {
    readonly descriptor: WorkspaceTransferDescriptor; readonly transfer: Transferable[]; readonly finished: Promise<void>;
  } {
  binding = decodeAssistanceBinding(binding);
  integer(transfer, "workspace transfer", 1, 0xffff_ffff);
  integer(input.bytes, "workspace stream bytes", 0, 1024 ** 4);
  const data = traffic.reserve(null, "data", 1024 * 1024);
  let control: number;
  try { control = traffic.reserve(null, "control", 16 * 1024); }
  catch (error) { traffic.release(null, data); throw error; }
  const channel = new MessageChannel();
  const cancellation = new AbortController();
  const cancelled = (): boolean => cancellation.signal.aborted;
  const finished = Promise.withResolvers<undefined>();
  void finished.promise.catch(() => {});
  let producer: WorkspaceStreamProducer | undefined;
  let iterator: AsyncIterator<Uint8Array<ArrayBuffer>, void, unknown> | undefined;
  let pulling: Promise<void> | undefined;
  let retirement: Promise<void> | undefined;
  let receiptSent = false;
  let terminal = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (): void => {
    if (terminal) return;
    terminal = true;
    cancellation.abort();
    clearTimeout(timer);
    channel.port1.close();
    finished.reject(new VMError("STORAGE_ERROR", "Workspace transfer retirement is uncertain", { cleanupFailed: true }));
    // Producer failure does not prove receiver retirement. Keep its credit fenced.
    void stop().catch(() => {});
  };
  const stop = (): Promise<void> => {
    cancellation.abort();
    retirement ??= (async () => {
      producer ??= input.source(cancellation.signal);
      await producer.retire();
      // Data failure is separate from the independent producer retirement above.
      await pulling?.catch(() => {});
      await iterator?.return?.();
    })();
    return retirement;
  };
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      pulling = (async () => {
        if (cancelled()) { controller.close(); return; }
        producer ??= input.source(cancellation.signal);
        iterator ??= producer.frames[Symbol.asyncIterator]();
        const next = await iterator.next();
        if (next.done === true || cancelled()) controller.close();
        else controller.enqueue(frame(next.value));
      })();
      // A failed data read still requires the separate retirement handshake.
      void pulling.catch(() => {});
      return pulling;
    },
    cancel: () => stop(),
  }, { highWaterMark: 0 });
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    try {
      const kind = receipt(event.data, binding, transfer);
      if (kind === "retire" && !receiptSent && timer === undefined) {
        timer = setTimeout(fail, RETIREMENT_MS);
        void stop().then(() => {
          if (terminal) return;
          receiptSent = true;
          channel.port1.postMessage(message(binding, transfer, "retired"));
        }, () => {
          channel.port1.postMessage(message(binding, transfer, "failed"));
          fail();
        });
      } else if (kind === "acknowledged" && receiptSent && !terminal) {
        terminal = true;
        clearTimeout(timer);
        channel.port1.close();
        traffic.release(null, data);
        traffic.release(null, control);
        finished.resolve(undefined);
      } else fail();
    } catch { fail(); }
  };
  channel.port1.onmessageerror = fail;
  channel.port1.start();
  return { descriptor: { version: PROTOCOL_VERSION, binding, transfer, bytes: input.bytes, stream, retirementPort: channel.port2 },
    transfer: [stream, channel.port2], finished: finished.promise };
}

export function receiveWorkspaceStream(value: unknown, binding: AssistanceBinding, transfer: number): WorkspaceStreamInput {
  binding = decodeAssistanceBinding(binding);
  integer(transfer, "workspace transfer", 1, 0xffff_ffff);
  const input = decodeWorkspaceTransfer(value);
  if (input.binding.session !== binding.session || input.binding.generation !== binding.generation
    || input.transfer !== transfer) return invalid();
  const { bytes, stream, retirementPort: port } = input;
  let opened = false;
  return { bytes, source(signal) {
    if (opened) return invalid();
    opened = true;
    const reader = stream.getReader();
    const aborted = (): boolean => signal.aborted;
    const retired = Promise.withResolvers<undefined>();
    void retired.promise.catch(() => {});
    let retirement: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (): void => retired.reject(new VMError("STORAGE_ERROR", "Workspace producer retirement failed", { cleanupFailed: true }));
    port.onmessage = (event: MessageEvent<unknown>) => {
      try {
        if (retirement === undefined || receipt(event.data, binding, transfer) !== "retired") { fail(); return; }
        retired.resolve(undefined);
      } catch { fail(); }
    };
    port.onmessageerror = fail;
    port.start();
    const retire = (): Promise<void> => {
      retirement ??= (async () => {
        timer = setTimeout(fail, RETIREMENT_MS);
        port.postMessage(message(binding, transfer, "retire"));
        const cancelled = reader.cancel();
        void cancelled.catch(() => {});
        try {
          await retired.promise;
          // An errored readable rejects cancel with its data error, even after
          // the independent native retirement receipt has arrived.
          await cancelled.catch(() => {});
          reader.releaseLock();
          port.postMessage(message(binding, transfer, "acknowledged"));
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          port.close();
        }
      })();
      void retirement.catch(() => {});
      return retirement;
    };
    const abort = (): void => { void retire().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return { retire, frames: (async function* () {
      for (;;) {
        if (signal.aborted) return;
        const next = await reader.read();
        if (next.done || aborted()) return;
        yield frame(next.value);
      }
    })() };
  } };
}

/** Rejection still owns the transferred producer. This retires it without
 * admitting its binding or publishing any bytes. */
export function retireWorkspaceTransfer(input: WorkspaceTransferDescriptor): Promise<void> {
  return receiveWorkspaceStream(input, input.binding, input.transfer).source(new AbortController().signal).retire();
}

function frame(value: unknown): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)
    || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength
    || value.byteLength < 1 || value.byteLength > 65536) return invalid();
  return new Uint8Array(value.buffer);
}
function message(binding: AssistanceBinding, transfer: number, kind: Receipt): object {
  return { version: PROTOCOL_VERSION, binding, transfer, kind };
}
function checkIdentity(input: Readonly<Record<string, unknown>>, binding: AssistanceBinding, transfer: number): void {
  const actual = decodeAssistanceBinding(input["binding"]);
  if (input["version"] !== PROTOCOL_VERSION || actual.session !== binding.session || actual.generation !== binding.generation
    || integer(input["transfer"], "workspace transfer", 1, 0xffff_ffff) !== transfer) invalid();
}
function receipt(value: unknown, binding: AssistanceBinding, transfer: number): Receipt {
  const input = record(value, "workspace retirement receipt");
  exactKeys(input, ["version", "binding", "transfer", "kind"]);
  checkIdentity(input, binding, transfer);
  const kind = input["kind"];
  if (kind !== "retire" && kind !== "retired" && kind !== "acknowledged" && kind !== "failed") return invalid();
  return kind;
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid workspace transfer"); }
