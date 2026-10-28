import type { RegistryRelayFetch } from "./registry-fetch.js";
import { SystemListeners } from "./system-listeners.js";
import { SystemRegistryEndpoint } from "./system-registry-endpoint.js";
import { registryMessagePort, registryVmBudget } from "./registry-transport.js";
import { deserializeError, serializeUnknownError, VMError } from "../errors.js";
import type { AssistanceBinding } from "../protocol/assistance.js";
import type { AssistanceCredit } from "../protocol/assistance-credit.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { decodeRegistryGatewayPolicy, decodeSystemNetworkMessage, type RegistryGatewayPolicy, type SystemNetworkMessage, type SystemListenerOperation } from "../protocol/system-network.js";
import { GrantedTraffic } from "./assistance/traffic.js";
import type { AssistanceTraffic } from "./control/assistance-traffic.js";

import { RegistryChannel } from "./registry-channel.js";
import { RegistryClient } from "./registry-client.js";
import { PreviewRuntimeClient } from "./preview-runtime-channel.js";
import { SystemPreviewRuntime } from "./system-preview-runtime.js";

const INTERVAL = 15_000;
const DEADLINE = 60_000;
const CONTROL_BYTES = 4096;

/** Control-owned liveness and grant lifecycle for one assistance generation.
 * The private port remains reusable only after a confirmed retirement. */
export class SystemNetworkClient {
  readonly #port: MessagePort;
  readonly #binding: AssistanceBinding;
  readonly #traffic: AssistanceTraffic;
  readonly #grants: readonly AssistanceCredit[];
  readonly #command: number;
  readonly #failed: (error: VMError) => void;
  readonly #startup = Promise.withResolvers<undefined>();
  readonly #retirement = Promise.withResolvers<undefined>();
  readonly ready = this.#startup.promise;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sequence = 1;
  #pending = 1;
  #closing = false;
  #retired = false;
  #failure: VMError | undefined;
  #exchange = Promise.withResolvers<undefined>();
  #registry: RegistryClient | SystemRegistryEndpoint | undefined;
  #registryRetirement: { readonly installation: number; readonly credits: readonly AssistanceCredit[] } | undefined;
  #openingRegistry = false;
  #lastInstallation = 0;
  #closeRequested = false;
  /** Control services preview runtime requests here; the network worker holds the other end. */
  readonly previewPort: MessagePort;

  constructor(port: MessagePort, binding: AssistanceBinding, traffic: AssistanceTraffic, failed: (error: VMError) => void) {
    this.#port = port; this.#binding = binding; this.#traffic = traffic; this.#failed = failed;
    // One bounded command/reply exchange, including simultaneous message copies.
    this.#command = traffic.reserve(null, "control", CONTROL_BYTES);
    const grants: AssistanceCredit[] = [];
    try {
      for (const pool of ["data", "control"] as const) grants.push(traffic.grant({ ...binding,
        producer: "network", process: null, pool, bytes: pool === "control" ? CONTROL_BYTES : 64 * 1024, entries: 4 }));
    } catch (error) {
      for (const grant of grants) traffic.returnCredit({ ...grant, kind: "return" });
      traffic.release(null, this.#command);
      port.close();
      throw error;
    }
    this.#grants = grants;
    const preview = new MessageChannel();
    this.previewPort = preview.port1;
    // Failure may precede the caller's later close; retain its shared outcome.
    void this.#retirement.promise.catch(() => undefined);
    void this.#exchange.promise.catch(() => undefined);
    port.onmessage = (event: MessageEvent<unknown>) => {
      try { this.#receive(decodeSystemNetworkMessage(event.data)); }
      catch (error) { this.fail(error); }
    };
    port.onmessageerror = () => this.fail(new VMError("PROTOCOL_ERROR", "Network port transfer failed"));
    port.start();
    this.#send({ version: PROTOCOL_VERSION, ...binding, kind: "bind", sequence: 1, credits: grants, preview: preview.port2 }, [preview.port2]);
  }

  #send(message: SystemNetworkMessage, transfer: Transferable[] = []): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.fail(new VMError("RELAY_ERROR", "System network owner liveness deadline exceeded")), DEADLINE);
    try { this.#port.postMessage(message, transfer); }
    catch (error) { this.fail(error); }
  }

  #receive(message: SystemNetworkMessage): void {
    if (message.session !== this.#binding.session || message.generation !== this.#binding.generation) {
      throw new VMError("PROTOCOL_ERROR", "Stale system network binding");
    }
    // A retirement can follow an in-flight heartbeat. Its earlier pong is still
    // valid, but cannot settle retirement or release the reserved window.
    if (this.#closing && message.kind === "pong" && message.sequence === this.#pending) { this.#pending = 0; return; }
    if (message.sequence !== this.#sequence) throw new VMError("PROTOCOL_ERROR", "Wrong system network reply sequence");
    if (message.kind === "retired" && this.#closing) {
      for (const credit of message.credits) {
        if (!this.#grants.some(grant => grant.reservation === credit.reservation && grant.sequence === credit.sequence
          && grant.pool === credit.pool && grant.bytes === credit.bytes && grant.entries === credit.entries)) {
          throw new VMError("PROTOCOL_ERROR", "Wrong network retirement credit");
        }
      }
      for (const credit of message.credits) this.#traffic.returnCredit(credit);
      this.#traffic.release(null, this.#command);
      this.#detach();
      this.#retired = true;
      this.#retirement.resolve(undefined);
      return;
    }
    if (message.kind === "registry-retired") {
      const expected = this.#registryRetirement;
      if (expected === undefined || message.installation !== expected.installation
        || message.credits.some(credit => !expected.credits.some(grant => grant.reservation === credit.reservation
          && grant.sequence === credit.sequence && grant.pool === credit.pool && grant.bytes === credit.bytes && grant.entries === credit.entries))) {
        throw new VMError("PROTOCOL_ERROR", "Wrong installation retirement receipt");
      }
      for (const credit of message.credits) this.#traffic.returnCredit(credit);
      this.#registryRetirement = undefined;
    }
    if ((message.kind !== "pong" && message.kind !== "registry-retired") || this.#closing || this.#pending !== message.sequence) {
      throw new VMError("PROTOCOL_ERROR", "Unexpected system network reply");
    }
    clearTimeout(this.#timer);
    this.#pending = 0;
    this.#startup.resolve(undefined);
    this.#exchange.resolve(undefined);
    this.#timer = setTimeout(() => {
      try { this.#exchange = Promise.withResolvers<undefined>(); void this.#exchange.promise.catch(() => undefined); this.#pending = this.#next(); this.#send({ version: PROTOCOL_VERSION, ...this.#binding, kind: "ping", sequence: this.#pending }); }
      catch (error) { this.fail(error); }
    }, INTERVAL);
  }

  /** Serialize metadata exchanges with heartbeats and registry retirement. The
   * waiting loop rechecks ownership after every wake, before assigning a sequence. */
  async #transmit(message: (sequence: number) => SystemNetworkMessage, transfer: Transferable[] = []): Promise<void> {
    while (this.#pending !== 0) await this.#exchange.promise;
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closing || this.#retired) throw new VMError("ABORTED", "Network generation retired");
    if (this.#sequence === 0xffff_ffff) throw new VMError("PROTOCOL_ERROR", "Network sequence exhausted");
    const command = message(this.#sequence + 1);
    this.#exchange = Promise.withResolvers<undefined>();
    void this.#exchange.promise.catch(() => undefined);
    this.#pending = this.#next();
    this.#send(command, transfer);
    await this.#exchange.promise;
  }

  async updateListener(operation: SystemListenerOperation): Promise<void> {
    if (this.#openingRegistry || this.#registry !== undefined || this.#closeRequested) {
      throw new VMError("ABORTED", "Network listener admission unavailable");
    }
    // Waiting messages are bounded by the same VM control budget as in-flight
    // commands. No application worker receives this private channel.
    const reservation = this.#traffic.reserve(null, "control", 512);
    try {
      await this.#transmit(sequence => {
        if (this.#openingRegistry || this.#registry !== undefined || this.#closeRequested) {
          throw new VMError("ABORTED", "Network listener admission unavailable");
        }
        return decodeSystemNetworkMessage({ version: PROTOCOL_VERSION, ...this.#binding, sequence, ...operation });
      });
    } finally { this.#traffic.release(null, reservation); }
  }

  #next(): number {
    if (this.#sequence === 0xffff_ffff) throw new VMError("PROTOCOL_ERROR", "Network sequence exhausted");
    return ++this.#sequence;
  }

  openRegistry(installation: number, policy: RegistryGatewayPolicy, signal?: AbortSignal): Promise<RegistryClient> {
    return this.#openRegistry(installation, policy, "registry", (port, credits) =>
      new RegistryClient(registryMessagePort(port), { ...this.#binding, installation }, registryVmBudget(this.#traffic), credits,
        error => this.fail(error), returned => { for (const credit of returned) this.#traffic.returnCredit(credit); }), signal);
  }

  openRegistryEndpoint(installation: number, policy: RegistryGatewayPolicy, signal?: AbortSignal): Promise<SystemRegistryEndpoint> {
    return this.#openRegistry(installation, policy, "registry-attach", (port, credits) => this.#endpoint(installation, port, credits), signal);
  }

  startRegistryGateway(installation: number, policy: RegistryGatewayPolicy,
    launch: (credits: readonly AssistanceCredit[]) => Promise<number>, signal?: AbortSignal): Promise<SystemRegistryEndpoint> {
    return this.#openRegistry(installation, policy, "registry-attach", (port, credits) => this.#endpoint(installation, port, credits), signal, launch);
  }

  #endpoint(installation: number, port: MessagePort, credits: readonly AssistanceCredit[]): SystemRegistryEndpoint {
    return new SystemRegistryEndpoint(port, credits, () => this.#retireRegistry(installation, credits),
      { ...this.#binding, installation }, registryVmBudget(this.#traffic), error => this.fail(error));
  }

  async #retireRegistry(installation: number, credits: readonly AssistanceCredit[]): Promise<void> {
    await this.#transmit(sequence => {
      this.#registryRetirement = { installation, credits };
      return { version: PROTOCOL_VERSION, ...this.#binding, kind: "registry-retire", sequence, installation };
    });
  }

  async #openRegistry<T extends RegistryClient | SystemRegistryEndpoint>(installation: number, policy: RegistryGatewayPolicy,
    kind: "registry" | "registry-attach", create: (port: MessagePort, credits: readonly AssistanceCredit[]) => T,
    signal?: AbortSignal, launch?: (credits: readonly AssistanceCredit[]) => Promise<number>): Promise<T> {
    if (this.#openingRegistry || this.#registry !== undefined || this.#closeRequested || this.#failure !== undefined) {
      throw new VMError("PROTOCOL_ERROR", "Network installation is active or retired");
    }
    if (!Number.isInteger(installation) || installation <= this.#lastInstallation || installation > 0xffff_ffff) {
      throw new VMError("PROTOCOL_ERROR", "Stale installation identity");
    }
    this.#openingRegistry = true;
    try {
      await this.#waitRegistryReady(signal);
      this.#assertRegistryActive(signal);
      const ports = new MessageChannel();
      const credits: AssistanceCredit[] = [];
      let registry: T;
      try {
        for (const pool of ["data", "control"] as const) credits.push(this.#traffic.grant({ ...this.#binding,
          producer: "network", process: null, pool,
          bytes: pool === "data" ? 1024 * 1024
            : (policy.gatewayOrigin === undefined && launch === undefined ? 128 * 1024 : 256 * 1024), entries: 32 }));
        // Validate the complete port handoff before transferring any authority.
        decodeSystemNetworkMessage({ version: PROTOCOL_VERSION, ...this.#binding, kind, sequence: 1,
          installation, port: ports.port1, policy, credits });
        if (launch !== undefined) {
          const port = await launch(credits);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new VMError("PROTOCOL_ERROR", "Invalid Linux gateway port");
          policy = decodeRegistryGatewayPolicy({ ...policy, gatewayOrigin: `http://127.0.0.1:${port}` });
          // Launch can span a heartbeat or generation retirement. Do not replace
          // an outstanding supervision exchange when handing off the endpoint.
          await this.#waitRegistryReady(signal);
          this.#assertRegistryActive(signal);
        }
        registry = create(ports.port2, credits);
      } catch (error) {
        ports.port1.close(); ports.port2.close();
        for (const credit of credits) this.#traffic.returnCredit({ ...credit, kind: "return" });
        throw error;
      }
      this.#registry = registry;
      this.#lastInstallation = installation;
      void registry.done.then(() => { if (this.#registry === registry) this.#registry = undefined; }, () => undefined);
      this.#bindRegistryCancellation(registry, signal);
      try {
        await this.#transmit(sequence => ({ version: PROTOCOL_VERSION, ...this.#binding, kind, sequence,
          installation, port: ports.port1, policy, credits }), [ports.port1]);
      } catch (error) { ports.port1.close(); this.fail(error); throw error; }
      // A handed-off installation owns producer grants until its independent
      // retirement receipt, even when cancellation overtakes startup readiness.
      if (signal?.aborted === true) await registry.close();
      this.#assertRegistryActive(signal);
      return registry;
    } finally { this.#openingRegistry = false; }
  }

  async #waitRegistryReady(signal?: AbortSignal): Promise<void> {
    this.#assertRegistryActive(signal);
    if (signal === undefined) { await this.#exchange.promise; return; }
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(new VMError("ABORTED", "Network installation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try { await Promise.race([this.#exchange.promise, aborted.promise]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  #bindRegistryCancellation(registry: RegistryClient | SystemRegistryEndpoint, signal?: AbortSignal): void {
    if (signal === undefined) return;
    const abort = () => { void registry.close().catch((error: unknown) => this.fail(error)); };
    const detach = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void registry.done.then(detach, detach);
  }

  #assertRegistryActive(signal?: AbortSignal): void {
    if (this.#closeRequested || this.#failure !== undefined || signal?.aborted === true) throw new VMError("ABORTED", "Network installation cancelled");
  }

  close(): Promise<undefined> {
    if (!this.#closeRequested && this.#failure === undefined) {
      this.#closeRequested = true;
      void this.#close().catch((error: unknown) => this.fail(error));
    }
    return this.#retirement.promise;
  }

  async #close(): Promise<void> {
    await this.#registry?.close();
    if (this.#failure !== undefined) return;
    this.#closing = true;
    const error = new VMError("ABORTED", "System network binding retired");
    this.#startup.reject(error); this.#exchange.reject(error);
    this.#send({ version: PROTOCOL_VERSION, ...this.#binding, kind: "retire", sequence: this.#next() });
  }

  fail(error: unknown): void {
    if (this.#failure !== undefined || this.#retired) return;
    this.#failure = deserializeError(serializeUnknownError(error));
    this.#detach(); this.#port.close();
    this.#startup.reject(this.#failure); this.#retirement.reject(this.#failure);
    this.#exchange.reject(this.#failure); this.#registry?.fail(this.#failure);
    this.#failed(this.#failure);
  }

  #detach(): void {
    this.previewPort.close();
    clearTimeout(this.#timer);
    this.#port.onmessage = null; this.#port.onmessageerror = null;
  }
}

interface BoundNetwork {
  readonly binding: AssistanceBinding;
  readonly traffic: GrantedTraffic;
  readonly listeners: SystemListeners;
  readonly previewClient: PreviewRuntimeClient;
  readonly previewPort: MessagePort;
  readonly preview: SystemPreviewRuntime;
  readonly control: number;
  readonly lifetime: AbortController;
  sequence: number;
  installation: number;
  creditSequence: number;
  registry: RegistryChannel | undefined;
  registrySupervised: boolean;
  registryRetiring: boolean;
  retiring: boolean;
}

/** Network-worker side. A lost control owner aborts its generation independently
 * of fetch progress; successful retirement permits a fresh generation to bind. */
export class SystemNetworkChannel {
  readonly #port: MessagePort;
  readonly #relay:RegistryRelayFetch|undefined;
  readonly #completion = Promise.withResolvers<undefined>();
  readonly done = this.#completion.promise;
  #bound: BoundNetwork | undefined;
  #previous: AssistanceBinding | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(port: MessagePort, relay?:RegistryRelayFetch) {
    this.#port = port;this.#relay=relay;
    port.onmessage = (event: MessageEvent<unknown>) => {
      try { this.#receive(decodeSystemNetworkMessage(event.data)); }
      catch (error) { for (const port of event.ports) port.close(); this.close(error); }
    };
    port.onmessageerror = () => this.close(new VMError("PROTOCOL_ERROR", "System network command transfer failed"));
    port.start();
  }

  get signal(): AbortSignal | undefined { return this.#bound?.lifetime.signal; }

  /** The system preview transport of the bound generation, if any. */
  get preview(): SystemPreviewRuntime | undefined { return this.#bound?.preview; }

  #receive(message: SystemNetworkMessage): void {
    if (message.kind === "bind") {
      if (this.#bound !== undefined || message.sequence !== 1 || (this.#previous !== undefined
        && (message.session !== this.#previous.session || message.generation <= this.#previous.generation))) {
        throw new VMError("PROTOCOL_ERROR", "Invalid network generation binding");
      }
      const binding = { session: message.session, generation: message.generation };
      const traffic = new GrantedTraffic({ ...binding, producer: "network", process: null }, message.credits, 6);
      const listeners = new SystemListeners(traffic);
      const lifetime = new AbortController();
      const previewClient = new PreviewRuntimeClient(message.preview);
      message.preview.onmessage = (event: MessageEvent<unknown>) => { previewClient.receive(event.data); };
      message.preview.start();
      const preview = new SystemPreviewRuntime(listeners, previewClient, lifetime.signal);
      this.#bound = { binding, traffic, listeners, previewClient, previewPort: message.preview, preview, control: traffic.reserve("control", CONTROL_BYTES), lifetime, sequence: 1, installation: 0, creditSequence: Math.max(...message.credits.map(credit => credit.sequence)), registry: undefined, registrySupervised: false, registryRetiring: false, retiring: false };
      this.#previous = binding;
    } else {
      const state = this.#bound;
      if (state === undefined || state.retiring || state.registryRetiring || message.session !== state.binding.session || message.generation !== state.binding.generation
        || message.sequence !== state.sequence + 1 || (message.kind !== "task-open" && message.kind !== "task-close" && message.kind !== "listener-open" && message.kind !== "listener-close" && message.kind !== "ping" && message.kind !== "retire" && message.kind !== "registry" && message.kind !== "registry-attach" && message.kind !== "registry-retire")) {
        throw new VMError("PROTOCOL_ERROR", "Stale system network command");
      }
      state.sequence = message.sequence;
      if (message.kind === "task-open" || message.kind === "task-close" || message.kind === "listener-open" || message.kind === "listener-close") {
        if (state.registry !== undefined) throw new VMError("PROTOCOL_ERROR", "Registry installation owns the network generation");
        switch (message.kind) {
          case "task-open": state.listeners.openTask(message.process); break;
          case "task-close": state.listeners.closeTask(message.process); break;
          case "listener-open": state.listeners.open(message.process, message.fd, message.address); break;
          case "listener-close": state.listeners.close(message.process, message.fd); break;
        }
      }
      if (message.kind === "registry" || message.kind === "registry-attach") {
        state.listeners.assertIdle();
        if (state.registry !== undefined || message.installation <= state.installation
          || message.credits.some(credit => credit.sequence <= state.creditSequence)) {
          message.port.close();
          throw new VMError("PROTOCOL_ERROR", "Stale registry installation or credits");
        }
        const traffic = new GrantedTraffic({ ...state.binding, producer: "network", process: null }, message.credits, 6);
        const registry = new RegistryChannel(message.port, { ...state.binding, installation: message.installation }, traffic, message.policy, state.lifetime.signal, this.#relay);
        state.registry = registry; state.installation = message.installation;
        state.registrySupervised = message.kind === "registry-attach";
        state.creditSequence = Math.max(...message.credits.map(credit => credit.sequence));
        void registry.done.then(() => { if (state.registry === registry && !state.registrySupervised) state.registry = undefined; }, (error: unknown) => this.close(error));
      }
      if (message.kind === "registry-retire") {
        if (!state.registrySupervised || state.registry === undefined || message.installation !== state.installation) {
          throw new VMError("PROTOCOL_ERROR", "Wrong supervised installation retirement");
        }
        state.registryRetiring = true;
        void this.#retireRegistry(state, state.registry, message.sequence).catch((error: unknown) => this.close(error));
        return;
      }
      if (message.kind === "retire") {
        state.retiring = true;
        void this.#retire(state, message.sequence).catch((error: unknown) => this.close(error));
        return;
      }
    }
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.close(new VMError("RELAY_ERROR", "System network control owner lost")), DEADLINE);
    this.#port.postMessage({ version: PROTOCOL_VERSION, session: message.session, generation: message.generation,
      sequence: message.sequence, kind: "pong" } satisfies SystemNetworkMessage);
  }

  async #retireRegistry(state: BoundNetwork, registry: RegistryChannel, sequence: number): Promise<void> {
    const credits = await registry.retire();
    if (this.#closed) return;
    state.registry = undefined;
    state.registryRetiring = false;
    this.#port.postMessage({ version: PROTOCOL_VERSION, ...state.binding, kind: "registry-retired", sequence,
      installation: state.installation, credits } satisfies SystemNetworkMessage);
  }

  async #retire(state: BoundNetwork, sequence: number): Promise<void> {
    await state.registry?.done;
    if (this.#closed) return;
    clearTimeout(this.#timer);
    state.listeners.retire();
    state.lifetime.abort();
    state.previewClient.close();
    state.previewPort.close();
    state.traffic.release(state.control);
    this.#port.postMessage({ version: PROTOCOL_VERSION, ...state.binding, sequence,
      kind: "retired", credits: state.traffic.returns() } satisfies SystemNetworkMessage);
    this.#bound = undefined;
  }

  close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#bound?.lifetime.abort();
    this.#bound?.previewClient.close();
    this.#bound?.previewPort.close();
    this.#port.onmessage = null; this.#port.onmessageerror = null; this.#port.close();
    if (error === undefined) this.#completion.resolve(undefined);
    else this.#completion.reject(deserializeError(serializeUnknownError(error)));
  }
}
