import type { RouterEgressEvent } from "../../netstack-abi.js";
import type { RelayRuntimeAdapter } from "../network-connection.js";
import type { RelayConnection } from "../relay-protocol.js";
import type { NetstackRouterApi } from "./router.js";

interface Flow {
  readonly kind: "tcp" | "dns";
  readonly generation: number; readonly id: number; readonly controller: AbortController;
  readonly connection: RelayConnection; stream: bigint | undefined;
  writing: boolean; guestEof: boolean;
}
/** Bridges the router's bounded sockets. Approval state belongs to RelayConnectionOwner. */
export class NetstackEgress implements RelayRuntimeAdapter {
  readonly #router: NetstackRouterApi;
  readonly #pump: () => void;
  readonly #flows = new Map<number, Flow>();
  readonly #waiters = new Set<() => void>();
  #connection: RelayConnection | undefined;
  #generation = 0;
  constructor(router: NetstackRouterApi, pump: () => void) { this.#router = router; this.#pump = pump; }
  setRelay(connection: RelayConnection | undefined, generation: number): Promise<void> {
    this.#clear(); this.#connection = connection; this.#generation = generation;
    this.#router.setNetwork(generation, connection !== undefined); this.#pump();
    return Promise.resolve();
  }
  /** A machine replacement revokes external transport without touching preview ownership. */
  reset(): void { this.#connection = undefined; this.#clear(); }
  #clear(): void {
    for (const flow of this.#flows.values()) { flow.controller.abort(); if (flow.stream !== undefined) flow.connection.close(flow.stream); }
    this.#flows.clear(); for (const waiter of this.#waiters) waiter();
  }
  wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
    for (let event = this.#router.egressNext(); event !== undefined; event = this.#router.egressNext()) this.#open(event);
    for (const flow of [...this.#flows.values()]) {
      if (flow.kind === "dns" || flow.stream === undefined) continue;
      const state = this.#router.egressStatus(flow.generation, flow.id);
      if (state === 0) { this.#forget(flow); continue; }
      if ((state & 2) !== 0 && !flow.writing) {
        flow.writing = true;
        void this.#write(flow).catch(() => { this.#reset(flow); }).finally(() => { flow.writing = false; this.#pump(); });
      }
      if ((state & 8) !== 0 && !flow.guestEof && !flow.writing) { flow.guestEof = true; try { flow.connection.shutdown(flow.stream, 1); } catch { this.#reset(flow); } }
    }
  }
  #open(event: RouterEgressEvent): void {
    const connection = this.#connection;
    if (connection === undefined || event.generation !== this.#generation) return;
    const flow: Flow = {kind: event.kind, generation: event.generation, id: event.id, controller: new AbortController(), connection, stream: undefined, writing: false, guestEof: false};
    this.#flows.set(event.id, flow);
    if (event.kind === "dns") {
      void this.#dns(flow, event.query).catch(() => { if (this.#current(flow)) this.#router.egressComplete(flow.generation,flow.id,5); }).finally(() => { this.#forget(flow); this.#pump(); });
      return;
    }
    void connection.openSocket({transport: "tcp", family: 2, address: event.address, port: event.port}, flow.controller.signal).then(stream => {
      if (!this.#current(flow)) { connection.close(stream); return; }
      flow.stream = stream;
      if (!this.#router.egressComplete(flow.generation, flow.id, 1)) { this.#forget(flow); return; }
      this.#pump();
      void this.#read(flow).catch(() => { this.#reset(flow); });
    }).catch(() => {
      if (this.#current(flow)) this.#router.egressComplete(flow.generation, flow.id, 2);
      this.#forget(flow); this.#pump();
    });
  }
  async #dns(flow: Flow, query: Uint8Array): Promise<void> {
    const address = new Uint8Array(16); address.set([192,0,2,1]);
    const stream = await flow.connection.openSocket({transport: "udp", family: 2, address, port: 53}, flow.controller.signal);
    if (!this.#current(flow)) { flow.connection.close(stream); return; }
    flow.stream = stream;
    await flow.connection.send(stream, query, flow.controller.signal);
    const bytes = await flow.connection.receive(stream, 4096, flow.controller.signal);
    if (this.#current(flow)) this.#router.egressComplete(flow.generation, flow.id, 5, bytes);
  }
  async #write(flow: Flow): Promise<void> {
    const stream = flow.stream; if (stream === undefined || !this.#current(flow)) return;
    const bytes = this.#router.egressReceive(flow.generation, flow.id, 16384);
    if (bytes.byteLength !== 0) await flow.connection.send(stream, bytes, flow.controller.signal);
  }
  async #read(flow: Flow): Promise<void> {
    const stream = flow.stream; if (stream === undefined) return;
    while (this.#current(flow)) {
      const bytes = await flow.connection.receive(stream, 16384, flow.controller.signal);
      if (!this.#current(flow)) return;
      if (bytes.byteLength === 0) { this.#router.egressComplete(flow.generation, flow.id, 3); this.#pump(); return; }
      let offset = 0;
      while (offset < bytes.byteLength && this.#current(flow)) {
        offset += this.#router.egressSend(flow.generation, flow.id, bytes.subarray(offset)); this.#pump();
        if (offset < bytes.byteLength) await this.#room(flow);
      }
    }
  }
  #room(flow: Flow): Promise<void> {
    return new Promise(resolve => {
      const wake = () => {
        if (this.#current(flow) && (this.#router.egressStatus(flow.generation, flow.id) & 4) === 0) return;
        this.#waiters.delete(wake); flow.controller.signal.removeEventListener("abort", wake); resolve();
      };
      this.#waiters.add(wake); flow.controller.signal.addEventListener("abort", wake, {once: true}); wake();
    });
  }
  #current(flow: Flow): boolean { return !flow.controller.signal.aborted && this.#flows.get(flow.id) === flow && this.#generation === flow.generation && this.#connection === flow.connection; }
  #reset(flow: Flow): void { if (this.#current(flow)) this.#router.egressComplete(flow.generation, flow.id, 4); this.#forget(flow); this.#pump(); }
  #forget(flow: Flow): void {
    flow.controller.abort(); if (flow.stream !== undefined) flow.connection.close(flow.stream);
    if (this.#flows.get(flow.id) === flow) this.#flows.delete(flow.id);
  }
}
