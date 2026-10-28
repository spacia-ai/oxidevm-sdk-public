import { VMError } from "./errors.js";
import type { NetworkState, RelayConnectionOptions, VMNetwork } from "./network-types.js";
import { PROTOCOL_VERSION } from "./protocol/common.js";
import { networkResponseDecoders, serializeRelayOptions, type NetworkOperations, type NetworkView } from "./protocol/network.js";
import { type WorkerClient, workerClientForPort } from "./worker-client.js";

export class NetworkClient implements VMNetwork {
  readonly #worker: (() => Worker) | undefined;
  readonly #scope: {readonly origin: string; readonly workspaceId: string; readonly workspaceName?: string; readonly serverAllowed?: boolean};
  readonly #prepare: () => Promise<void>;
  readonly #revoke: () => Promise<void>;
  readonly #lifetime = new AbortController();
  readonly #subscribers = new Set<(state: NetworkState) => void>();
  #view: NetworkView = {revision: 0, state: {kind: "off"}};
  #client: WorkerClient<NetworkOperations> | undefined;
  #watching: Promise<void> | undefined;
  #disposed = false;
  #failure: VMError | undefined;

  constructor(worker: () => Worker, scope: {readonly origin: string; readonly workspaceId: string; readonly workspaceName?: string; readonly serverAllowed?: boolean}, prepare: () => Promise<void> = async () => {}, revoke: () => Promise<void> = async () => {}) {
    this.#worker = worker; this.#scope = scope; this.#prepare = prepare; this.#revoke = revoke;
  }
  static fromPort(port: MessagePort, pageUrl: string): NetworkClient {
    const client = new NetworkClient(() => { throw new VMError("PROTOCOL_ERROR", "Network port already attached"); }, {origin: new URL(pageUrl).origin, workspaceId: "port"});
    client.#client = workerClientForPort(port, networkResponseDecoders, "settled");
    return client;
  }
  get state(): NetworkState { return this.#view.state; }
  async connect(options: RelayConnectionOptions, request: {readonly signal?: AbortSignal} = {}): Promise<void> {
    const serialized = serializeRelayOptions(options, typeof location === "undefined" ? this.#scope.origin : location.href);
    if (serialized.kind === "server" && this.#scope.serverAllowed === false) throw new VMError("FEATURE_NOT_AVAILABLE", "Server relay is disabled by this application");
    const client = this.#ensure();
    await this.#prepare();
    try {
      this.#accept(await client.request("network-connect", {options: serialized}, {signal: request.signal}));
    } catch (error: unknown) {
      // The response and observer use separate requests. Read the owner's settled
      // view before rejecting so a caller sees the failure immediately.
      if (this.#failure === undefined) {
        this.#accept(await client.request("network-state", undefined));
      }
      throw error;
    }
  }
  async disconnect(): Promise<void> {
    if (this.#client !== undefined && this.#failure === undefined) this.#accept(await this.#client.request("network-disconnect", undefined));
  }
  watch(onChange: (state: NetworkState) => void, options: {readonly signal: AbortSignal}): Promise<void> {
    if (options.signal.aborted) return Promise.resolve();
    this.#ensure();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.#subscribers.delete(listener); options.signal.removeEventListener("abort", stop); this.#lifetime.signal.removeEventListener("abort", stop); };
      const stop = () => { cleanup(); resolve(); };
      const listener = (state: NetworkState) => {
        try { onChange(state); } catch (error: unknown) { cleanup(); reject(error instanceof Error ? error : new Error("Network observer failed", {cause:error})); }
      };
      this.#subscribers.add(listener);
      options.signal.addEventListener("abort", stop, {once: true});
      this.#lifetime.signal.addEventListener("abort", stop, {once: true});
      listener(this.state);
      if (options.signal.aborted || this.#lifetime.signal.aborted) stop();
    });
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try { await this.disconnect(); } finally {
      this.#disposed = true; this.#lifetime.abort(); this.#client?.terminate(); await this.#watching;
    }
  }
  async fail(): Promise<void> {
    if (this.#failure !== undefined || this.#disposed) return;
    this.#failure = new VMError("RELAY_ERROR", "Network worker stopped", {reason: "disconnected"});
    this.#client?.terminate(this.#failure);
    this.#view = {revision: this.#view.revision, state: {kind: "failed", reason: "disconnected"}};
    for (const subscriber of this.#subscribers) subscriber(this.state);
    await this.#revoke();
  }
  #ensure(): WorkerClient<NetworkOperations> {
    if (this.#disposed) throw new VMError("ABORTED", "VM is disposed");
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#client === undefined) {
      const worker = this.#worker?.();
      if (worker === undefined) throw new VMError("PROTOCOL_ERROR", "Missing network worker");
      const channel = new MessageChannel();
      this.#client = workerClientForPort(channel.port1, networkResponseDecoders, "settled");
      worker.addEventListener("error", this.#workerFailed, {signal: this.#lifetime.signal});
      worker.addEventListener("messageerror", this.#workerFailed, {signal: this.#lifetime.signal});
      worker.postMessage({version: PROTOCOL_VERSION, type: "connect-network-control", port: channel.port2, serverAllowed: this.#scope.serverAllowed ?? true, ...this.#scope, pageUrl: typeof location === "undefined" ? this.#scope.origin : location.href}, [channel.port2]);
    }
    this.#watching ??= this.#observe(this.#client);
    return this.#client;
  }
  readonly #workerFailed = () => { void this.fail(); };
  async #observe(client: WorkerClient<NetworkOperations>): Promise<void> {
    try {
      while (!this.#lifetime.signal.aborted) this.#accept(await client.request("network-watch", {afterRevision: this.#view.revision}, {signal: this.#lifetime.signal}));
    } catch {
      if (!this.#lifetime.signal.aborted) await this.fail();
    }
  }
  #accept(view: NetworkView): void {
    if (view.revision <= this.#view.revision) return;
    this.#view = view;
    for (const subscriber of this.#subscribers) subscriber(view.state);
  }
}
