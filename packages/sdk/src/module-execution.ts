import { VMError } from "./runtime/errors.js";

/**
 * A VM's module frame on the page that opens it (engine ADR 0028), modelled on `native-execution.ts`. The first
 * `spawnModule` or `enableModuleCommands` opens it; the broker's port then goes to the VM's Userspace worker
 * (`attach-module-frame`), behind which every module process runs. The frame lives as long as the VM. A frame that is
 * removed from the document or stops answering is lost: the worker ends the module processes with status 125
 * (`detach-module-frame`) and the next call opens a new frame, from the sources it already read. On dispose the VM's
 * worker, and with it the verified-copy store, goes first; then the frame.
 */

/** How often the page asks the frame document whether it is alive, and how many answers it may miss. */
export const MODULE_FRAME_HEARTBEAT_MS = 5_000;
export const MODULE_FRAME_MISSED_BEATS = 3;

/** The broker and runner code the frame starts, read from the opener's own SDK assets. */
export interface ModuleFrameSources { readonly broker: Blob; readonly runner: Blob }

/** One open frame, as its owner needs it; the browser opener (`module-frame-browser.ts`) holds the element. */
export interface ModuleFrameHandle {
  /** The broker's port (module broker protocol 1), for the VM's Userspace worker. */
  readonly port: MessagePort;
  dispose(): void;
}

/** What only a document can do: open and watch frames. The composition root supplies it (`browserModuleFrames`). */
export type ModuleFrameOpener = Pick<ModuleExecutionPorts, "open" | "sources" | "watch">;

export interface ModuleExecutionPorts {
  /** Opens one frame from the sources (the real one: `openModuleFrame` on the SDK's own assets). */
  readonly open: (sources: ModuleFrameSources, signal: AbortSignal | undefined) => Promise<ModuleFrameHandle>;
  /** Reads the broker and runner code from the opener's own SDK assets, once per VM. */
  readonly sources: (signal: AbortSignal | undefined) => Promise<ModuleFrameSources>;
  /** Hands the broker's port to the VM's Userspace worker. */
  readonly attach: (port: MessagePort) => Promise<void>;
  /** Tells the VM's Userspace worker that the frame is gone. */
  readonly detach: () => Promise<void>;
  /** Calls `lost` once the frame leaves the document or stops answering; returns the watch's end. */
  readonly watch: (frame: ModuleFrameHandle, lost: () => void) => () => void;
}

interface Opened { readonly frame: ModuleFrameHandle; readonly unwatch: () => void }

export class ModuleExecution {
  readonly #ports: ModuleExecutionPorts;
  #sources: Promise<ModuleFrameSources> | undefined;
  #opening: Promise<Opened> | undefined;
  #disposed = false;

  constructor(ports: ModuleExecutionPorts) { this.#ports = ports; }

  /** The VM's frame, opened on first use and after a loss. A browser that cannot isolate modules is refused with its
   * capability, and nothing is started or attached; the next call tries again. */
  async ensure(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "VM has been disposed");
    const opening = this.#opening ??= this.#open(signal);
    try { await opening; }
    catch (error: unknown) { if (this.#opening === opening) this.#opening = undefined; throw error; }
  }

  async #open(signal: AbortSignal | undefined): Promise<Opened> {
    const sources = await (this.#sources ??= this.#ports.sources(signal).catch((error: unknown) => { this.#sources = undefined; throw error; }));
    const frame = await this.#ports.open(sources, signal);
    try {
      if (this.#disposed) throw new VMError("PROTOCOL_ERROR", "VM has been disposed");
      await this.#ports.attach(frame.port);
    } catch (error: unknown) { frame.dispose(); throw error; }
    const opened: Opened = { frame, unwatch: this.#ports.watch(frame, () => { void this.#lost(opened); }) };
    return opened;
  }

  async #lost(opened: Opened): Promise<void> {
    const current = this.#opening;
    if (current === undefined || await current.catch(() => undefined) !== opened) return;
    this.#opening = undefined;
    opened.unwatch(); opened.frame.dispose();
    if (!this.#disposed) await this.#ports.detach().catch(() => undefined);
  }

  /** The VM is gone (its worker first): the frame goes too. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const opening = this.#opening;
    this.#opening = undefined;
    const opened = await opening?.catch(() => undefined);
    opened?.unwatch(); opened?.frame.dispose();
  }
}
