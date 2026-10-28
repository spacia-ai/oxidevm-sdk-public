import { installationCapture } from "./installation-capture.js";
import { INSTALLATION_WRITE_WINDOW } from "../../protocol/assistance-installation.js";
import { VMError } from "../../errors.js";
import type { RegistryBinding } from "../../protocol/registry.js";
import type { InstallationRequest } from "../../protocol/assistance-installation.js";
import type { InstallationReply } from "../../protocol/assistance-installation-reply.js";
import type { AssistanceTraffic } from "./assistance-traffic.js";
import type { GuestAgent } from "./guest-agent.js";
import type { InstallationExchangeObservation } from "./installation-profile.js";

export type InstallationProcessOperation = { readonly kind: "execute" | "validate-inputs" | "blocked-builds" | "check-current" }
  | Extract<InstallationRequest["operation"], { kind: "set-build-policy" | "stdin" | "close-stdin" | "signal" | "output-ack" }>;

/** One authenticated guest pipe, driven by the existing execution pump. The
 * enclosing installation retains its lease and issued grants through close. */
export interface InstallationStreamOptions {
  readonly beforeClose?: () => Promise<void> | undefined;
  /** Attribution only: called after each completed exchange, never on the I/O path's ordering. */
  readonly observe?: (observation: InstallationExchangeObservation) => void;
}

export function installationStreams(agent: Pick<GuestAgent, "installation">, identity: RegistryBinding,
  initialSequence: number, traffic: AssistanceTraffic, options: InstallationStreamOptions = {}) {
  const { beforeClose, observe } = options;
  if (!Number.isInteger(initialSequence) || initialSequence < 1 || initialSequence >= 0xffff_fffe) {
    throw new VMError("PROTOCOL_ERROR", "Invalid installation stream sequence");
  }
  // Covers one read/write, their encoded frames and simultaneous copies. The
  // only writer is the separately bounded registry byte transport.
  const data = traffic.reserve(null, "data", 1024 * 1024);
  let control: number;
  try { control = traffic.reserve(null, "control", 64 * 1024); }
  catch (error) { traffic.release(null, data); throw error; }
  let sequence = initialSequence;
  let closing = false;
  const isClosing = (): boolean => closing;
  let failed = false;
  let failure: unknown;
  let completion: Promise<void> | undefined;
  let released: Promise<void> | undefined;
  let materialized: Promise<void> | undefined;
  const captures = new Map<"dependencies" | "snapshot" | "delta", Promise<ReturnType<typeof installationCapture>>>();
  let captureRetirements = 0;
  const isReleased = () => released !== undefined;
  const captured: ReturnType<typeof installationCapture>[] = [];
  const captureWindows: number[] = [];
  let captureData: number | undefined;
  let retained = false;
  let inputEnded = false;
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pending = new Set<Promise<InstallationReply>>();
  let processWindow: readonly [number, number] | undefined;
  let processData = false;
  let processControl = 0;
  // Bounded write pipelining: the guest pipe admits this many queued writes and
  // completes them in sequence order, so no frame can interleave with another.
  const WRITE_WINDOW = INSTALLATION_WRITE_WINDOW;
  let outstandingWrites = 0;
  let writeSlot = Promise.withResolvers<undefined>();

  function process(operation: InstallationProcessOperation): Promise<InstallationReply> {
    if (isClosing()) throw new VMError("ABORTED", "Installation pipe closed");
    const supervisory = operation.kind === "signal" || operation.kind === "output-ack";
    if (supervisory ? processControl >= 4 : processData) {
      throw new VMError("QUOTA_EXCEEDED", "Installer request capacity exhausted");
    }
    if (processWindow === undefined) {
      // One stdin frame, simultaneous encoded copies, envelopes and reply space.
      const bytes = traffic.reserve(null, "data", 280 * 1024);
      try { processWindow = [bytes, traffic.reserve(null, "control", 16 * 1024)]; }
      catch (error) { traffic.release(null, bytes); throw error; }
    }
    const request = next(operation, supervisory);
    if (supervisory) processControl += 1;
    else processData = true;
    return exchange(request).finally(() => {
      if (supervisory) processControl -= 1;
      else processData = false;
    });
  }

  function endInput(): void {
    if (inputEnded) return;
    inputEnded = true;
    inputController?.close();
  }
  function next(operation: InstallationRequest["operation"], supervisory = false): InstallationRequest {
    if (isClosing() || (completion !== undefined && !supervisory)) throw new VMError("ABORTED", "Installation pipe closed");
    if (sequence >= 0xffff_fffd) throw new VMError("QUOTA_EXCEEDED", "Installation stream sequence exhausted");
    return allocate(operation);
  }
  function allocate(operation: InstallationRequest["operation"]): InstallationRequest {
    if (sequence >= 0xffff_fffe) throw new VMError("QUOTA_EXCEEDED", "Installation stream sequence exhausted");
    return { ...identity, sequence: ++sequence, operation };
  }
  function exchange(request: InstallationRequest): Promise<InstallationReply> {
    const work = (async () => {
      // A step that throws is observed as well: the profile then names the
      // refused step instead of missing the exchange altogether.
      const requested = performance.now();
      let reply: InstallationReply;
      try { reply = await agent.installation(0, request); }
      catch (error: unknown) {
        observe?.({ kind: request.operation.kind, requestMs: performance.now() - requested, acknowledgeMs: 0, bytes: 0, failed: "request" });
        throw error;
      }
      const replied = performance.now();
      const bytes = reply.result.kind === "data" ? reply.result.bytes.length : reply.result.kind === "written" ? reply.result.count : 0;
      let acknowledged: InstallationReply;
      try { acknowledged = await agent.installation(0, { ...identity, sequence: request.sequence, operation: { kind: "acknowledge" } }); }
      catch (error: unknown) {
        observe?.({ kind: request.operation.kind, requestMs: replied - requested, acknowledgeMs: performance.now() - replied, bytes, failed: "acknowledge" });
        throw error;
      }
      const failed = acknowledged.result.kind === "acknowledged" ? null : "acknowledge";
      observe?.({ kind: request.operation.kind, requestMs: replied - requested, acknowledgeMs: performance.now() - replied, bytes, failed });
      if (failed !== null) throw new VMError("PROTOCOL_ERROR", "Installation completion was not acknowledged");
      if (reply.result.kind === "error" && request.operation.kind !== "validate-inputs" && request.operation.kind !== "blocked-builds" && request.operation.kind !== "check-current" && request.operation.kind !== "materialize" && request.operation.kind !== "activate-materialized" && request.operation.kind !== "capture" && request.operation.kind !== "capture-read" && request.operation.kind !== "workspace-capture" && request.operation.kind !== "workspace-capture-read" && !(isClosing() && reply.result.errno === 125)) {
        throw new VMError("RELAY_ERROR", "Installation pipe I/O failed", { errno: reply.result.errno });
      }
      return reply;
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), (error: unknown) => {
      pending.delete(work);
      if (!failed) { failed = true; failure = error; }
    });
    return work;
  }
  function shutdown(kind: "stop" | "retire"): Promise<void> {
    if (completion !== undefined) return completion;
    retained = kind === "retire";
    completion = (async () => {
      // Registry cancellation also reaches this path. Preserve the installer
      // channel for terminal delivery before retiring the enclosing producers.
      const termination = beforeClose === undefined ? [] : await Promise.allSettled([Promise.resolve().then(beforeClose)]);
      const stoppingSequence = kind === "retire" ? allocate({ kind }).sequence : 0xffff_ffff;
      closing = true;
      { const slot = writeSlot; writeSlot = Promise.withResolvers<undefined>(); slot.resolve(undefined); }
      // Stop first: a blocked read/write cannot retire itself while its native
      // producer remains alive. The guest still accepts completion ACKs.
      let stopped;
      try { stopped = await agent.installation(0, { ...identity, sequence: stoppingSequence, operation: { kind } }); }
      catch (error) {
        // The guest could not even take the stop: nothing will ever complete the
        // exchanges still in flight, so waiting for them would hang forever.
        if (!failed) { failed = true; failure = error; }
        pending.clear();
        throw error;
      }
      if (stopped.result.kind !== (retained ? "retired" : "stopped")) throw new VMError("RELAY_ERROR", "Installation writer retirement failed");
      const results = await Promise.allSettled([...pending]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      if (failed) throw failure;
      endInput();
      if (processWindow !== undefined) for (const reservation of processWindow) traffic.release(null, reservation);
      traffic.release(null, data);
      if (!retained) traffic.release(null, control);
      for (const result of termination) if (result.status === "rejected") throw result.reason;
    })();
    void completion.catch(() => {});
    return completion;
  }
  function materialize(): Promise<void> {
    materialized ??= (async () => {
      if (!retained || completion === undefined) throw new VMError("PROTOCOL_ERROR", "Materialization requires writer retirement");
      await completion;
      if (isReleased()) throw new VMError("ABORTED", "Installation already released");
      const reply = await exchange(allocate({ kind: "materialize" }));
      if (reply.result.kind === "error" && reply.result.errno === 125) throw new VMError("ABORTED", "Dependency materialization cancelled");
      if (reply.result.kind !== "materialized") throw new VMError("RELAY_ERROR", "Dependency materialization failed",
        reply.result.kind === "error" ? { errno: reply.result.errno } : undefined);
    })();
    void materialized.catch(() => {});
    return materialized;
  }
  /** After every capture retired, Linux moves its materialized tree into the
   * committed generation under storage's identity. One attempt per installation. */
  async function activate(identity: { readonly generation: Uint8Array<ArrayBuffer>; readonly inputs: Uint8Array<ArrayBuffer> }): Promise<void> {
    if (materialized === undefined) throw new VMError("PROTOCOL_ERROR", "Activation requires materialization");
    await materialized;
    if (isReleased()) throw new VMError("ABORTED", "Installation already released");
    const reply = await exchange(allocate({ kind: "activate-materialized", generation: identity.generation, inputs: identity.inputs }));
    if (reply.result.kind === "error" && reply.result.errno === 125) throw new VMError("ABORTED", "Dependency activation cancelled");
    if (reply.result.kind !== "unit") throw new VMError("STORAGE_ERROR", "Guest did not activate the materialized dependencies",
      reply.result.kind === "error" ? { errno: reply.result.errno } : undefined);
  }
  function capture(source: "dependencies" | "snapshot" | "delta" = "dependencies"): Promise<ReturnType<typeof installationCapture>> {
    const existing = captures.get(source);
    if (existing !== undefined) return existing;
    const capturing = (async () => {
      if (materialized === undefined) throw new VMError("PROTOCOL_ERROR", "Capture requires materialization");
      await materialized;
      if (isReleased()) throw new VMError("ABORTED", "Installation already released");
      if (sequence >= 0xffff_fffd - captureRetirements) throw new VMError("QUOTA_EXCEEDED", "Capture requires a retirement sequence");
      // Three sources, each with one 64 KiB read: four simultaneous copies per
      // source plus 192 KiB for envelopes/fragments fit 960 KiB. Native
      // queues and transferred frames retain their separate issued windows.
      captureData ??= traffic.reserve(null, "data", 960 * 1024);
      captureWindows.push(traffic.reserve(null, "control", 16 * 1024));
      captureRetirements += 1;
      const ready = await exchange(allocate(source === "dependencies" ? { kind: "capture" } : { kind: "workspace-capture", source }));
      if (ready.result.kind !== "capture-ready") throw new VMError("STORAGE_ERROR", "Capture did not start");
      if (isReleased()) throw new VMError("ABORTED", "Installation already released");
      const input = installationCapture(ready.result.bytes, async operation => {
        if (operation.kind === "capture-read" && sequence >= 0xffff_fffe - captureRetirements) {
          throw new VMError("QUOTA_EXCEEDED", "Capture sequence exhausted; retirement remains reserved");
        }
        const request = source === "dependencies" ? operation : operation.kind === "capture-read"
          ? { kind: "workspace-capture-read", source, length: operation.length } as const
          : { kind: "workspace-capture-retire", source } as const;
        const result = await exchange(allocate(request));
        if (operation.kind === "capture-retire" && result.result.kind === "capture-retired") captureRetirements -= 1;
        return result;
      });
      captured.push(input);
      return input;
    })();
    captures.set(source, capturing);
    void capturing.catch(() => {});
    return capturing;
  }
  function close(): Promise<void> { return shutdown("stop"); }
  function retire(): Promise<void> { return shutdown("retire"); }
  function release(): Promise<void> {
    released ??= (async () => {
      await close();
      if (!retained) return;
      for (const input of captured) await input.retire();
      const reply = await agent.installation(0, { ...identity, sequence: 0xffff_ffff, operation: { kind: "stop" } });
      if (reply.result.kind !== "stopped") throw new VMError("RELAY_ERROR", "Installation release failed");
      const results = await Promise.allSettled([...pending]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      // A confirmed copy failure is independent of successful writer cleanup.
      await materialized?.catch(() => {});
      await Promise.allSettled(captures.values());
      if (failed) throw failure;
      for (const reservation of captureWindows) traffic.release(null, reservation);
      if (captureData !== undefined) traffic.release(null, captureData);
      traffic.release(null, control);
    })();
    return released;
  }
  const input = new ReadableStream<Uint8Array>({
    start(controller) { inputController = controller; },
    async pull(controller) {
      if (isClosing()) { endInput(); return; }
      const reply = await exchange(next({ kind: "read", length: 65_536 }));
      if (isClosing()) { endInput(); return; }
      if (reply.result.kind !== "data") throw new VMError("PROTOCOL_ERROR", "Invalid installation read completion");
      if (reply.result.bytes.length === 0) endInput();
      else controller.enqueue(reply.result.bytes);
    },
    cancel() { inputEnded = true; return close(); },
  }, { highWaterMark: 0 });
  const output = new WritableStream<Uint8Array>({
    async write(bytes) {
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length === 0 || bytes.length > 65_536) {
        throw new VMError("PROTOCOL_ERROR", "Invalid installation write chunk");
      }
      while (outstandingWrites >= WRITE_WINDOW && !failed && !isClosing()) await writeSlot.promise;
      if (failed) throw failure;
      if (isClosing()) return;
      // Admission returns once the write is in flight; completion arrives in
      // sequence order and a short completion cannot be re-issued safely.
      outstandingWrites += 1;
      const work = exchange(next({ kind: "write", bytes }));
      void work.then(reply => {
        if (isClosing() || failed) return;
        if (reply.result.kind !== "written" || reply.result.count !== bytes.length) {
          failed = true; failure = new VMError("PROTOCOL_ERROR", "Invalid installation write completion");
        }
      }, () => {}).finally(() => {
        outstandingWrites -= 1;
        const slot = writeSlot; writeSlot = Promise.withResolvers<undefined>(); slot.resolve(undefined);
      });
    },
    close,
    abort: close,
  });
  return { input, output, process, close, retire, materialize, activate, capture, release };
}
