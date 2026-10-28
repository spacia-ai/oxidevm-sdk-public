import { VMError } from "../../errors.js";
import { linuxSignalName } from "../../guest-process.js";
import type { ProcessHandle } from "../../vm-types.js";
import type { RegistryBinding } from "../../protocol/registry.js";
import type { InstallationEvent } from "../../protocol/assistance-installation-event.js";
import type { installationStreams } from "./installation-stream.js";
import type { AssistanceTraffic } from "./assistance-traffic.js";

type Output = { readonly sequence: number; readonly bytes: Uint8Array<ArrayBuffer> };
type Stream = {
  readonly queue: Output[];
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  wake: PromiseWithResolvers<undefined> | undefined;
  cancelled: boolean;
  closed: boolean;
  eof: boolean;
  draining: Promise<void> | undefined;
};

/** Native installer I/O. Publication and the installation lease outlive exit;
 * only confirmed enclosing producer retirement releases this receive window. */
export class InstallationProcess implements ProcessHandle {
  readonly #identity: RegistryBinding;
  readonly #call: ReturnType<typeof installationStreams>["process"];
  readonly #traffic: AssistanceTraffic;
  readonly #stop: () => Promise<void>;
  readonly #failedOwner: (error: unknown) => void;
  readonly #window: number;
  readonly #ready = Promise.withResolvers<undefined>();
  readonly #termination = Promise.withResolvers<{ code: number | null; signal?: string }>();
  readonly exit = this.#termination.promise;
  readonly #outputDrained = Promise.withResolvers<undefined>();
  readonly outputDrained = this.#outputDrained.promise;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly #streams: Record<"stdout" | "stderr", Stream>;
  readonly #early: InstallationEvent[] = [];
  #child: number | undefined;
  #started = false;
  #exited = false;
  #retired = false;
  #sequence = 0;
  #bytes = 0;
  #entries = 0;
  #failure: unknown;
  #failed = false;

  constructor(identity: RegistryBinding, call: ReturnType<typeof installationStreams>["process"], traffic: AssistanceTraffic,
    stop: () => Promise<void>, failed: (error: unknown) => void) {
    this.#identity = identity; this.#call = call; this.#traffic = traffic; this.#stop = stop;
    this.#failedOwner = failed;
    // Includes two stream queues, startup records and simultaneous decoded copies.
    this.#window = traffic.reserve(null, "data", 512 * 1024);
    const stream = (): Stream => ({ queue: [], controller: undefined, wake: undefined,
      cancelled: false, closed: false, eof: false, draining: undefined });
    this.#streams = { stdout: stream(), stderr: stream() };
    this.stdout = this.#readable("stdout"); this.stderr = this.#readable("stderr");
    this.stdin = new WritableStream<Uint8Array>({
      write: async bytes => {
        await this.#ready.promise;
        if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) throw new VMError("INVALID_ARGUMENT", "Invalid installer stdin");
        const child = this.#liveChild();
        for (let offset = 0; offset < bytes.length;) {
          const part = bytes.subarray(offset, offset + 65_536);
          const reply = await this.#call({ kind: "stdin", child, bytes: part });
          if (reply.result.kind !== "written" || reply.result.count < 1 || reply.result.count > part.length) throw new VMError("PROTOCOL_ERROR", "Invalid installer stdin completion");
          offset += reply.result.count;
        }
      },
      close: async () => {
        await this.#ready.promise;
        const reply = await this.#call({ kind: "close-stdin", child: this.#liveChild() });
        if (reply.result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid installer stdin EOF completion");
      },
      abort: () => this.kill("KILL"),
    });
    void this.outputDrained.catch(() => {});
    void this.exit.catch(() => {}); void this.#ready.promise.catch(() => {});
  }

  async start(): Promise<void> {
    if (this.#started || this.#retired) throw new VMError("PROTOCOL_ERROR", "Installer startup already consumed");
    this.#started = true;
    try {
      const reply = await this.#call({ kind: "execute" });
      if (reply.result.kind === "error" && reply.result.errno === 125) throw new VMError("ABORTED", "Installer startup cancelled");
      if (reply.result.kind !== "spawned") throw new VMError("PROTOCOL_ERROR", "Installer did not spawn");
      this.#child = reply.result.child;
      for (const event of this.#early.splice(0)) this.#apply(event);
      this.#ready.resolve(undefined);
    } catch (error) { this.#fail(error); throw error; }
  }

  receive(message: InstallationEvent): void {
    try { this.#receive(message); }
    catch (error) { this.#fail(error); throw error; }
  }

  #receive(message: InstallationEvent): void {
    if (this.#retired || this.#failed || message.session !== this.#identity.session || message.generation !== this.#identity.generation
      || message.installation !== this.#identity.installation || message.sequence <= this.#sequence) {
      throw new VMError("PROTOCOL_ERROR", "Invalid installer event identity");
    }
    this.#sequence = message.sequence;
    const event = message.event;
    if (event.kind === "output") {
      if (this.#bytes + event.bytes.length > 128 * 1024 || this.#entries >= 128) throw new VMError("QUOTA_EXCEEDED", "Installer output window exhausted");
      this.#bytes += event.bytes.length; this.#entries += 1;
    }
    if (this.#child === undefined) {
      if (!this.#started || this.#early.length >= 128) throw new VMError("PROTOCOL_ERROR", "Unexpected installer startup event");
      this.#early.push(message);
    } else this.#apply(message);
  }

  #apply(message: InstallationEvent): void {
    const event = message.event;
    if (event.kind === "failure") throw new VMError("GUEST_CRASH", "Installer service failed", { errno: event.errno });
    if (event.child !== this.#child) throw new VMError("PROTOCOL_ERROR", "Unknown installer child");
    if (event.kind === "exit") {
      if (this.#exited) throw new VMError("PROTOCOL_ERROR", "Duplicate installer exit");
      this.#exited = true;
      this.#termination.resolve(event.code === null ? { code: null, signal: linuxSignalName(event.signal) } : { code: event.code });
      return;
    }
    const state = this.#streams[event.stream];
    if (state.eof) throw new VMError("PROTOCOL_ERROR", "Installer output after EOF");
    if (event.kind === "eof") state.eof = true;
    else state.queue.push({ sequence: message.sequence, bytes: event.bytes });
    state.wake?.resolve(undefined); state.wake = undefined;
    this.#completeOutput();
    if (state.cancelled) void this.#discard(event.stream).catch((error: unknown) => this.#fail(error));
  }

  #readable(stream: "stdout" | "stderr"): ReadableStream<Uint8Array> {
    const state = this.#streams[stream];
    const cancelled = (): boolean => state.cancelled;
    return new ReadableStream<Uint8Array>({
      start: controller => { state.controller = controller; },
      pull: async controller => {
        while (state.queue.length === 0 && !state.eof) {
          if (cancelled()) return;
          if (this.#failed) throw this.#failure;
          state.wake ??= Promise.withResolvers<undefined>();
          await state.wake.promise;
        }
        if (cancelled()) return;
        if (this.#failed) throw this.#failure;
        const output = state.queue.shift();
        if (output !== undefined) {
          controller.enqueue(output.bytes);
          await this.#ack(stream, output);
        }
        if (state.queue.length === 0 && state.eof && !state.closed && !cancelled()) {
          state.closed = true; controller.close();
        }
      },
      cancel: () => { state.cancelled = true; state.wake?.resolve(undefined); return this.#discard(stream); },
    }, { highWaterMark: 0 });
  }

  #discard(stream: "stdout" | "stderr"): Promise<void> {
    const state = this.#streams[stream];
    state.draining ??= (async () => {
      for (let output = state.queue.shift(); output !== undefined; output = state.queue.shift()) await this.#ack(stream, output);
    })().finally(() => {
      state.draining = undefined;
      if (state.queue.length !== 0 && !this.#failed) void this.#discard(stream).catch((error: unknown) => this.#fail(error));
    });
    return state.draining;
  }

  async #ack(stream: "stdout" | "stderr", output: Output): Promise<void> {
    if (this.#child === undefined) throw new VMError("PROTOCOL_ERROR", "Installer child unavailable");
    try {
      const reply = await this.#call({ kind: "output-ack", child: this.#child, stream, sequence: output.sequence, bytes: output.bytes.length });
      if (reply.result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid installer output acknowledgement");
      this.#bytes -= output.bytes.length; this.#entries -= 1;
      this.#completeOutput();
    } catch (error) { this.#fail(error); throw error; }
  }

  #completeOutput(): void {
    if (this.#failed || this.#entries !== 0 || Object.values(this.#streams).some(state => !state.eof)) return;
    for (const state of Object.values(this.#streams)) {
      if (!state.closed && !state.cancelled) { state.closed = true; state.controller?.close(); }
    }
    this.#outputDrained.resolve(undefined);
  }

  async kill(signal = "TERM"): Promise<void> {
    const number = signal === "TERM" ? 15 : signal === "KILL" ? 9 : signal === "INT" ? 2 : signal === "HUP" ? 1 : undefined;
    if (number === undefined) throw new VMError("INVALID_ARGUMENT", "Unsupported installer signal");
    await this.#ready.promise;
    if (this.#exited) { await this.#stop(); return; }
    const reply = await this.#call({ kind: "signal", child: this.#liveChild(), signal: number });
    if (reply.result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid installer signal completion");
  }

  /** Preserve an admitted child's actual exit before its enclosing channel closes.
   * Pending startup is cancelled by native Stop, which owns launch retirement. */
  async terminate(): Promise<void> {
    if (this.#child === undefined || this.#exited || this.#failed || this.#retired) return;
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => expired.reject(new VMError("GUEST_CRASH", "Installer termination did not report an exit")), 30_000);
    try {
      await Promise.race([(async () => {
        const reply = await this.#call({ kind: "signal", child: this.#liveChild(), signal: 9 });
        if (reply.result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid installer termination completion");
        await this.exit;
      })(), expired.promise]);
    } finally { clearTimeout(timer); }
  }

  #liveChild(): number {
    if (this.#failed) throw this.#failure;
    if (this.#child === undefined || this.#exited || this.#retired) throw new VMError("ABORTED", "Installer process is not running");
    return this.#child;
  }

  #fail(error: unknown, notify = true): void {
    if (this.#failed) return;
    this.#failed = true; this.#failure = error;
    this.#ready.reject(error); this.#termination.reject(error); this.#outputDrained.reject(error);
    for (const state of Object.values(this.#streams)) {
      if (!state.closed && !state.cancelled) { state.closed = true; state.controller?.error(error); }
      state.wake?.resolve(undefined); state.wake = undefined;
    }
    if (notify) this.#failedOwner(error);
  }

  /** Called only after Stop confirms native/channel retirement and reply drain. */
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#fail(new VMError("ABORTED", "Installer producers retired"), false);
    this.#early.length = 0;
    for (const state of Object.values(this.#streams)) state.queue.length = 0;
    this.#traffic.release(null, this.#window);
  }
}
