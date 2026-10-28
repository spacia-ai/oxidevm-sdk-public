import { REGISTRY_CONCURRENCY, REGISTRY_PROTOCOL_VERSION } from "../protocol/registry.js";
import type { RegistryProtocolVersion } from "../protocol/registry.js";
import type { AssistanceCredit } from "../protocol/assistance-credit.js";
import { VMError, serializeUnknownError } from "../errors.js";
import { decodeRegistryReply, decodeRegistryRequest, type RegistryBinding, type RegistryReply, type RegistryRequest } from "../protocol/registry.js";
import type { GrantedTraffic } from "./assistance/traffic.js";
import type { RegistryRelayFetch, RegistryFetchPolicy } from "./registry-fetch.js";
import { RegistryRequests } from "./registry-requests.js";

/** Installation-scoped network port. Startup/read waits never serialize
 * cancellation. Its supervisor must fence the VM if done rejects. */
export class RegistryChannel {
  readonly #port: MessagePort;
  readonly #binding: RegistryBinding;
  readonly #requests: RegistryRequests;
  readonly #traffic: GrantedTraffic;
  readonly #supervision: number;
  readonly #commands: number;
  #pendingCommands = 0;
  readonly #controls = new Map<number, number>();
  readonly #operations = new Set<Promise<void>>();
  readonly #lifetime: AbortSignal;
  readonly #completion = Promise.withResolvers<undefined>();
  readonly done = this.#completion.promise;
  #draining: Promise<readonly AssistanceCredit[]> | undefined;
  #supervisorRetirement: Promise<readonly AssistanceCredit[]> | undefined;
  #sequence = 0;
  #version: RegistryProtocolVersion = REGISTRY_PROTOCOL_VERSION;
  #sent = 0;
  #closing = false;
  #failed = false;
  readonly #ownerLost = () => this.#fail(new VMError("RELAY_ERROR", "Registry transport owner lost; retire the installation"));

  constructor(port: MessagePort, binding: RegistryBinding, traffic: GrantedTraffic, policy: RegistryFetchPolicy, lifetime: AbortSignal, relay?:RegistryRelayFetch) {
    this.#port = port;
    this.#binding = binding;
    this.#traffic = traffic;
    // Fixed acknowledgement/retirement envelopes never wait for data capacity.
    this.#supervision = traffic.reserve("control", 2048);
    // Each admitted URL has at most 4096 UTF-16 units: 16 KiB covers two
    // simultaneous copies. Its envelope and reply use the control reservation.
    // Reserve these slots before responses can consume the remaining window.
    try { this.#commands = traffic.reserve("data", REGISTRY_CONCURRENCY * 16 * 1024); }
    catch (error) { traffic.release(this.#supervision); throw error; }
    this.#requests = new RegistryRequests(traffic, policy, undefined, relay);
    this.#lifetime = lifetime;
    port.onmessage = (event: MessageEvent<unknown>) => this.#receive(event.data);
    port.onmessageerror = () => this.#fail(new VMError("PROTOCOL_ERROR", "Registry message transfer failed"));
    port.start();
    lifetime.addEventListener("abort", this.#ownerLost, { once: true });
    if (lifetime.aborted) this.#ownerLost();
  }

  /** The supervisor must fence the downstream receiver before reclaiming its
   * queued replies. This receipt waits for every upstream producer to retire. */
  retire(): Promise<readonly AssistanceCredit[]> {
    this.#supervisorRetirement ??= this.#retireFromSupervisor();
    return this.#supervisorRetirement;
  }

  async #retireFromSupervisor(): Promise<readonly AssistanceCredit[]> {
    this.#closing = true;
    this.#closePort();
    try {
      const credits = await this.#drain();
      this.#completion.resolve(undefined);
      return credits;
    } catch (error) {
      this.#fail(error);
      await this.done;
      throw error;
    }
  }

  #receive(value: unknown): void {
    if (this.#closing) return;
    let request: RegistryRequest;
    try {
      request = decodeRegistryRequest(value);
      if (this.#sequence === 0) this.#version = request.version;
      if (request.session !== this.#binding.session || request.generation !== this.#binding.generation
        || request.installation !== this.#binding.installation || request.sequence <= this.#sequence || request.version !== this.#version) {
        throw new VMError("PROTOCOL_ERROR", "Wrong or stale registry request identity");
      }
      this.#sequence = request.sequence;
    } catch (error) { this.#fail(error); return; }
    if (request.kind === "acknowledge" || request.kind === "acknowledge-control") {
      try {
        if (request.kind === "acknowledge") this.#requests.acknowledge(request.request, request.reservation);
        else {
          if (this.#controls.get(request.reservation) !== request.correlation) throw new VMError("PROTOCOL_ERROR", "Invalid registry control acknowledgement");
          this.#controls.delete(request.reservation);
          this.#traffic.release(request.reservation);
        }
      } catch (error) { this.#fail(error); }
      return;
    }
    if (request.kind === "retire") {
      this.#closing = true;
      void this.#retire(request.sequence).catch((error: unknown) => this.#fail(error));
      return;
    }
    // Reserve the reply (including a possible failure) before starting work.
    // A start URL has at most 4096 UTF-16 units; this also covers wire copies.
    let control: number;
    const command = request.kind === "start" || request.kind === "read";
    try {
      if (command && this.#pendingCommands >= REGISTRY_CONCURRENCY) throw new VMError("QUOTA_EXCEEDED", "Registry command capacity exhausted");
      control = this.#traffic.reserve("control", 16 * 1024);
      if (command) this.#pendingCommands += 1;
    } catch (error) { this.#fail(error); return; }
    const operation = this.#dispatch(request, control).catch((error: unknown) => {
      if (this.#closing) {
        return;
      }
      if (error instanceof VMError && error.code === "PROTOCOL_ERROR") { this.#fail(error); return; }
      try { this.#sendControl({ ...this.#envelope(request.sequence), kind: "failure", reservation: control, error: serializeUnknownError(error) }); }
      catch (failure) { this.#fail(failure); }
    }).finally(() => {
      this.#operations.delete(operation);
      if (command) this.#pendingCommands -= 1;
      if (!this.#failed) {
        if (!this.#controls.has(control)) this.#traffic.release(control);
      }
    });
    this.#operations.add(operation);
    void operation.catch((error: unknown) => this.#fail(error));
  }

  async #dispatch(input: Extract<RegistryRequest, { kind: "start" | "read" | "cancel" }>, control: number): Promise<void> {
    switch (input.kind) {
      case "start": {
        const identity = this.#traffic.reserve("control", 16 * 1024);
        let started: ReturnType<RegistryRequests["start"]>;
        try { started = this.#requests.start(input.url, input.representation); }
        catch (error) { this.#traffic.release(identity); throw error; }
        // Supervise the response even when transferring the early ID fails.
        const response = started.response;
        void response.catch(() => undefined);
        this.#sendControl({ ...this.#envelope(input.sequence), kind: "started", request: started.request, reservation: identity });
        const headers = await response;
        this.#send({ ...this.#envelope(input.sequence), kind: "headers", ...headers });
        return;
      }
      case "read": {
        const result = await this.#requests.read(input.request);
        const bytes = result.bytes.slice();
        this.#send({ ...this.#envelope(input.sequence), kind: "data", request: input.request, ...result, bytes }, [bytes.buffer]);
        return;
      }
      case "cancel":
        await this.#requests.cancel(input.request);
        this.#sendControl({ ...this.#envelope(input.sequence), kind: "cancelled", request: input.request, reservation: control });
        return;
    }
  }

  async #retire(correlation: number): Promise<void> {
    const credits = await this.#drain();
    if (this.#supervisorRetirement === undefined) {
      // Attribution rides only on the current dialect; embedded dialect-31 gateways reject unknown fields.
      this.#port.postMessage({ ...this.#envelope(correlation), kind: "retired", credits,
        ...(this.#version === 31 ? {} : { profile: this.#requests.profile() }) } satisfies RegistryReply);
    }
    this.#closePort();
    this.#completion.resolve(undefined);
  }

  #drain(): Promise<readonly AssistanceCredit[]> {
    this.#draining ??= (async () => {
      await this.#requests.retire();
      await Promise.all([...this.#operations]);
      if (this.#failed) await this.done;
      for (const reservation of this.#controls.keys()) this.#traffic.release(reservation);
      this.#controls.clear();
      this.#traffic.release(this.#supervision);
      this.#traffic.release(this.#commands);
      return this.#traffic.returns();
    })();
    return this.#draining;
  }

  #sendControl(reply: Extract<RegistryReply, { kind: "started" | "cancelled" | "failure" }>): void {
    // Track even a failed transfer: only confirmed retirement can reclaim it.
    this.#controls.set(reply.reservation, reply.correlation);
    decodeRegistryReply(reply);
    this.#send(reply);
  }

  #envelope(correlation: number) {
    if (this.#sent === 0xffff_ffff) throw new VMError("PROTOCOL_ERROR", "Registry response sequences exhausted");
    return { version: this.#version, ...this.#binding, sequence: ++this.#sent, correlation } as const;
  }

  #send(reply: RegistryReply, transfer: Transferable[] = []): void {
    if (this.#closing) return;
    try { this.#port.postMessage(reply, transfer); }
    catch { throw new VMError("PROTOCOL_ERROR", "Registry reply transfer failed"); }
  }

  #closePort(): void {
    this.#lifetime.removeEventListener("abort", this.#ownerLost);
    this.#port.onmessage = null;
    this.#port.onmessageerror = null;
    this.#port.close();
  }

  #fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#closing = true;
    this.#closePort();
    const failure = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "Registry channel failed");
    void this.#requests.retire().then(
      () => this.#completion.reject(failure),
      (cleanup: unknown) => this.#completion.reject(cleanup),
    );
  }
}
