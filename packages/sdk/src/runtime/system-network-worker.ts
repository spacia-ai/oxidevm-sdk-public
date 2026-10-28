// The system VM's network worker, started on first use. It carries the assisted network's port
// (ADR 0012) and, for managed boots, the router behind the full-system network link (ADR 0015).
// A failed worker reaches the control worker through each path it carries.
import { VMError } from "./errors.js";
import { createFrameBridgeBuffer } from "./frame-bridge.js";
import { type ControlOperations, PROTOCOL_VERSION } from "./protocol.js";
import type { WorkerClient } from "./worker-client.js";

const DEFAULT_NETSTACK_WASM_URL = "/oxidevm_netstack.wasm";

export class SystemNetworkWorker {
  readonly #control: WorkerClient<ControlOperations>;
  readonly #netstackWasmUrl: string | undefined;
  #worker: Worker | undefined;
  #assistance = false;
  #assistanceFailure: VMError | undefined;
  #link: Promise<void> | undefined;
  #linked = false;
  #linkFailureReported = false;

  constructor(control: WorkerClient<ControlOperations>, netstackWasmUrl: string | undefined) {
    this.#control = control;
    this.#netstackWasmUrl = netstackWasmUrl;
  }

  /** The network worker, once something started it. */
  get worker(): Worker | undefined {
    return this.#worker;
  }

  /** Whether the network link's router is up: a managed boot started it and the worker lives. */
  get linked(): boolean {
    return this.#linked;
  }

  /** Connects the assisted network; the VM is created with it or not at all. */
  async connectAssistance(): Promise<void> {
    const network = this.start();
    this.#assistance = true;
    const ports = new MessageChannel();
    try {
      network.postMessage({ version: PROTOCOL_VERSION, type: "connect-system", port: ports.port1 }, [ports.port1]);
      await this.#control.request("assistance-network-attach", { port: ports.port2 }, { transfer: [ports.port2] });
      if (this.#assistanceFailure !== undefined) throw this.#assistanceFailure;
    } catch (error) {
      ports.port1.close();
      ports.port2.close();
      throw error;
    }
  }

  /** Starts the network link once per VM and resolves when the router is ready. A page that is not
   * cross-origin isolated has no shared memory and so no link; a failed start lets the next
   * managed boot try again. */
  connectLink(signal?: AbortSignal): Promise<void> {
    this.#link ??= this.#startLink(signal).catch((error: unknown) => {
      this.#link = undefined;
      throw error;
    });
    return this.#link;
  }

  terminate(): void {
    this.#worker?.terminate();
  }

  async #startLink(signal: AbortSignal | undefined): Promise<void> {
    const network = this.start();
    const bridge = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated ? createFrameBridgeBuffer() : "message";
    const doorbell = new MessageChannel();
    try {
      network.postMessage({
        version: PROTOCOL_VERSION,
        type: "connect-link",
        bridge,
        doorbell: doorbell.port2,
        netstackWasmUrl: new URL(this.#netstackWasmUrl ?? DEFAULT_NETSTACK_WASM_URL, globalThis.location.href).href,
      }, [doorbell.port2]);
      await this.#control.request(
        "network-link-connect",
        { bridge, doorbell: doorbell.port1 },
        { ...(signal === undefined ? {} : { signal }), transfer: [doorbell.port1] },
      );
      this.#linked = true;
    } catch (error) {
      doorbell.port1.close();
      throw error;
    }
  }

  start(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const worker = new Worker(new URL("./workers/network.worker.js", import.meta.url), { name: "oxidevm-network", type: "module" });
    worker.addEventListener("error", this.#failed);
    worker.addEventListener("messageerror", this.#failed);
    this.#worker = worker;
    return worker;
  }

  readonly #failed = (): void => {
    if (this.#assistance && this.#assistanceFailure === undefined) {
      this.#assistanceFailure = new VMError("RELAY_ERROR", "System network worker failed; reopen the VM");
      void this.#control.request("assistance-network-failed", undefined).catch(() => {
        // A lost control worker already fences the VM through its own lifetime.
      });
    }
    if (this.#link !== undefined && !this.#linkFailureReported) {
      this.#linkFailureReported = true;
      this.#linked = false;
      void this.#control.request("network-link-failed", undefined).catch(() => {
        // As above: a lost control worker fences the VM itself.
      });
    }
  };
}
