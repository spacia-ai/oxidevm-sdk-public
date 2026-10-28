import { INSTALLATION_PROFILE_REQUEST_LIMIT, type InstallationExchangeFailure, type InstallationExchangeKind, type InstallationExchangeObservation,
  type InstallationGatewayLockfile, type InstallationNetworkProfile, type InstallationPhaseName, type InstallationProfile } from "../../protocol/assistance-installation-profile.js";
import type { RegistryReply, RegistryRequest } from "../../protocol/registry.js";
export type { InstallationExchangeObservation, InstallationPhaseName, InstallationProfile } from "../../protocol/assistance-installation-profile.js";

type ExchangeKind = InstallationExchangeKind;
const REQUEST_LIMIT = INSTALLATION_PROFILE_REQUEST_LIMIT;

interface MutableRegistryRequest {
  request: number; startedMs: number; headersMs: number | null; reads: number; bytes: number;
  networkWaitMs: number; maxNetworkWaitMs: number; gapMs: number; maxGapMs: number; done: boolean;
  readAt: number | undefined; deliveredAt: number | undefined;
}

/** Bounded, control-owned attribution record for one dependency installation.
 * Recording never throws and never changes transport ordering or windows. */
export class InstallationProfileRecorder {
  readonly #installation: number;
  readonly #now: () => number;
  readonly #phases: { name: InstallationPhaseName; startedMs: number; endedMs: number | null }[] = [];
  readonly #exchanges = new Map<ExchangeKind, { count: number; bytes: number; requestMs: number; maxRequestMs: number; acknowledgeMs: number; maxAcknowledgeMs: number;
    failures: number; lastFailure: InstallationExchangeFailure | null }>();
  readonly #requests = new Map<number, MutableRegistryRequest>();
  #dropped = 0;
  #network: InstallationNetworkProfile | null = null;
  #gateway: InstallationGatewayLockfile | null = null;

  constructor(installation: number, now: () => number = () => performance.now()) {
    this.#installation = installation;
    this.#now = now;
  }

  begin(name: InstallationPhaseName): void {
    this.#phases.push({ name, startedMs: this.#now(), endedMs: null });
  }

  end(name: InstallationPhaseName): void {
    for (let index = this.#phases.length - 1; index >= 0; index--) {
      const phase = this.#phases[index];
      if (phase !== undefined && phase.name === name && phase.endedMs === null) { phase.endedMs = this.#now(); return; }
    }
  }

  exchange(observation: InstallationExchangeObservation): void {
    const entry = this.#exchanges.get(observation.kind)
      ?? { count: 0, bytes: 0, requestMs: 0, maxRequestMs: 0, acknowledgeMs: 0, maxAcknowledgeMs: 0, failures: 0, lastFailure: null };
    entry.count += 1; entry.bytes += observation.bytes;
    entry.requestMs += observation.requestMs; entry.maxRequestMs = Math.max(entry.maxRequestMs, observation.requestMs);
    entry.acknowledgeMs += observation.acknowledgeMs; entry.maxAcknowledgeMs = Math.max(entry.maxAcknowledgeMs, observation.acknowledgeMs);
    if (observation.failed !== null) { entry.failures += 1; entry.lastFailure = observation.failed; }
    this.#exchanges.set(observation.kind, entry);
  }

  /** A request the guest gateway issued toward the network owner. */
  registryRequest(request: RegistryRequest): void {
    const now = this.#now();
    if (request.kind === "start") {
      if (this.#requests.size >= REQUEST_LIMIT) { this.#dropped += 1; return; }
      const id = request.sequence;
      this.#requests.set(id, { request: id, startedMs: now, headersMs: null, reads: 0, bytes: 0, networkWaitMs: 0, maxNetworkWaitMs: 0,
        gapMs: 0, maxGapMs: 0, done: false, readAt: undefined, deliveredAt: undefined });
      return;
    }
    if (request.kind !== "read") return;
    const entry = this.#requests.get(request.request);
    if (entry === undefined) return;
    entry.readAt = now;
    if (entry.deliveredAt !== undefined) {
      const gap = now - entry.deliveredAt;
      entry.gapMs += gap; entry.maxGapMs = Math.max(entry.maxGapMs, gap); entry.deliveredAt = undefined;
    }
  }

  /** A reply the network owner produced for the guest gateway. */
  registryReply(reply: RegistryReply): void {
    const now = this.#now();
    if (reply.kind === "retired") { if (reply.profile !== undefined) this.#network = { ...reply.profile }; return; }
    if (reply.kind === "failure") return;
    if (reply.kind === "started") {
      const entry = this.#requests.get(reply.correlation);
      if (entry !== undefined && entry.request !== reply.request) { this.#requests.delete(reply.correlation); this.#requests.set(reply.request, { ...entry, request: reply.request }); }
      return;
    }
    const entry = this.#requests.get(reply.request);
    if (entry === undefined) return;
    if (reply.kind === "headers") { entry.headersMs ??= now; return; }
    if (reply.kind !== "data") { entry.done = true; return; }
    entry.reads += 1; entry.bytes += reply.bytes.byteLength; entry.done = reply.done;
    if (entry.readAt !== undefined) {
      const wait = now - entry.readAt;
      entry.networkWaitMs += wait; entry.maxNetworkWaitMs = Math.max(entry.maxNetworkWaitMs, wait); entry.readAt = undefined;
    }
    entry.deliveredAt = reply.done ? undefined : now;
  }

  network(profile: InstallationNetworkProfile): void { this.#network = profile; }
  /** The gateway's lockfile outcome, set once the installation configured it. */
  gateway(lockfile: InstallationGatewayLockfile): void { this.#gateway = lockfile; }

  snapshot(): InstallationProfile {
    return {
      installation: this.#installation,
      phases: this.#phases.map(phase => ({ ...phase })),
      exchanges: [...this.#exchanges].map(([kind, entry]) => ({ kind, ...entry })),
      registry: {
        requests: [...this.#requests.values()].map(({ readAt, deliveredAt, ...entry }) => { void readAt; void deliveredAt; return { ...entry }; }),
        dropped: this.#dropped,
        network: this.#network === null ? null : { ...this.#network },
      },
      gateway: this.#gateway === null ? null : { ...this.#gateway },
    };
  }
}
