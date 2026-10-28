// The full-system network link in the system trace (schema 43, ADR 0015): the link's state and
// generation, the control worker's bridge counts, and the counters of the core's network card and
// of the router, each of which must reconcile. Checkpoints and frozen captures record none.
import { coreNetworkCountersReconcile, type CoreNetworkCounters, type CoreNetworkDrops } from "../core-abi/network.js";
import { bigint, exactKeys, integer, protocolError, record } from "../decode.js";
import type { RouterFailure } from "../frame-bridge.js";
import { netstackCountersReconcile, type NetstackCounters } from "../netstack-abi.js";
import type { SystemTraceSnapshot } from "./system.js";

export interface SystemTraceNetworkProfile {
  /** "absent" when the VM never started the link. */
  readonly link: "absent" | "detached" | "attached" | "failed";
  readonly failure: RouterFailure | "worker" | "timeout" | null;
  readonly generation: number;
  readonly bridge: {
    readonly givenFrames: number;
    readonly givenBytes: number;
    readonly takenFrames: number;
    readonly takenBytes: number;
    readonly giveBackpressure: number;
    readonly takeRingFull: number;
    readonly kicks: number;
  };
  readonly core: CoreNetworkCounters | null;
  readonly router: NetstackCounters | null;
}

const LINKS = ["absent", "detached", "attached", "failed"] as const;
const FAILURES = ["fetch", "compile", "exports", "version", "init", "trap", "protocol", "worker", "timeout"] as const;
const BRIDGE_KEYS = ["givenFrames", "givenBytes", "takenFrames", "takenBytes", "giveBackpressure", "takeRingFull", "kicks"] as const;
const ROUTER_KEYS = [
  "framesIn", "bytesIn", "toStack", "inboundQueued",
  "replyArp", "replyDhcpOffer", "replyDhcpAck", "replyDhcpNak", "replyTcpReset", "replyIcmpProhibited",
  "dropMalformed", "dropNotForRouter", "dropIpv6", "dropOtherEthertype", "dropArpIgnored", "dropFragment",
  "dropBroadcast", "dropTcpNotSyn", "dropOtherProtocol", "dropDhcpIgnored", "dropInboundFull", "dropLinkReset",
  "stackTransmitted", "framesOut", "bytesOut", "outboundQueued", "outboundDropFull", "outboundDropLinkReset",
  "opensRequested", "openBusy", "openConnected", "openRefused", "openTimedOut", "openCanceled", "openingNow",
  "connectionsOpenNow", "connectionsClosed", "connectionsReset", "fallbackAttempts", "framingErrors",
] as const satisfies readonly (keyof NetstackCounters)[];

/** The network profile of a schema-43 trace; null for earlier schemas and for captures without one. */
export function decodeSystemTraceNetworkProfile(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceNetworkProfile | null {
  if (schemaVersion < 43) {
    if (value !== undefined) throw protocolError("system traces before schema 43 carry no network profile");
    return null;
  }
  if (value === null) return null;
  const network = record(value, "system network profile");
  exactKeys(network, ["link", "failure", "generation", "bridge", "core", "router"]);
  const bridge = record(network["bridge"], "system network bridge profile");
  exactKeys(bridge, BRIDGE_KEYS);
  return {
    link: oneOf(network["link"], LINKS, "network link state"),
    failure: network["failure"] === null ? null : oneOf(network["failure"], FAILURES, "network link failure"),
    generation: integer(network["generation"], "network link generation", 0, 0x7fff_ffff),
    bridge: {
      givenFrames: count(bridge["givenFrames"], "given frames"),
      givenBytes: count(bridge["givenBytes"], "given bytes"),
      takenFrames: count(bridge["takenFrames"], "taken frames"),
      takenBytes: count(bridge["takenBytes"], "taken bytes"),
      giveBackpressure: count(bridge["giveBackpressure"], "give backpressure"),
      takeRingFull: count(bridge["takeRingFull"], "full to-router ring"),
      kicks: count(bridge["kicks"], "doorbell kicks"),
    },
    core: network["core"] === null ? null : decodeCoreCounters(network["core"]),
    router: network["router"] === null ? null : decodeRouterCounters(network["router"], schemaVersion),
  };
}

function decodeCoreCounters(value: unknown): CoreNetworkCounters {
  const core = record(value, "core network counters");
  exactKeys(core, ["backend", "transmit", "receive"]);
  const transmit = record(core["transmit"], "core transmit counters");
  exactKeys(transmit, ["frames", "bytes", "responder", "takenFrames", "takenBytes", "drops", "queued"]);
  const receive = record(core["receive"], "core receive counters");
  exactKeys(receive, ["givenFrames", "givenBytes", "responderReplies", "drops", "restored", "queued", "deliveredFrames", "deliveredBytes", "framingErrors"]);
  const counters: CoreNetworkCounters = {
    backend: oneOf(core["backend"], ["test-responder", "host-link"] as const, "core network backend"),
    transmit: {
      frames: total(transmit["frames"]),
      bytes: total(transmit["bytes"]),
      responder: total(transmit["responder"]),
      takenFrames: total(transmit["takenFrames"]),
      takenBytes: total(transmit["takenBytes"]),
      drops: decodeDrops(transmit["drops"]),
      queued: total(transmit["queued"]),
    },
    receive: {
      givenFrames: total(receive["givenFrames"]),
      givenBytes: total(receive["givenBytes"]),
      responderReplies: total(receive["responderReplies"]),
      drops: decodeDrops(receive["drops"]),
      restored: total(receive["restored"]),
      queued: total(receive["queued"]),
      deliveredFrames: total(receive["deliveredFrames"]),
      deliveredBytes: total(receive["deliveredBytes"]),
      framingErrors: total(receive["framingErrors"]),
    },
  };
  if (!coreNetworkCountersReconcile(counters)) throw protocolError("core network counters do not reconcile");
  return counters;
}

function decodeDrops(value: unknown): CoreNetworkDrops {
  const drops = record(value, "core network drops");
  exactKeys(drops, ["queueFull", "oversize", "malformed"]);
  return { queueFull: total(drops["queueFull"]), oversize: total(drops["oversize"]), malformed: total(drops["malformed"]) };
}

function decodeRouterCounters(value: unknown, schemaVersion: number): NetstackCounters {
  const router = record(value, "router counters");
  exactKeys(router, schemaVersion >= 46 ? [...ROUTER_KEYS, "egressHeld", "dropEgressPending", "replyDns"] : ROUTER_KEYS);
  const field = (key: typeof ROUTER_KEYS[number]): bigint => total(router[key]);
  const counters: NetstackCounters = {
    framesIn: field("framesIn"), bytesIn: field("bytesIn"), toStack: field("toStack"), inboundQueued: field("inboundQueued"),
    replyArp: field("replyArp"), replyDhcpOffer: field("replyDhcpOffer"), replyDhcpAck: field("replyDhcpAck"),
    replyDhcpNak: field("replyDhcpNak"), replyTcpReset: field("replyTcpReset"), replyIcmpProhibited: field("replyIcmpProhibited"),
    dropMalformed: field("dropMalformed"), dropNotForRouter: field("dropNotForRouter"), dropIpv6: field("dropIpv6"),
    dropOtherEthertype: field("dropOtherEthertype"), dropArpIgnored: field("dropArpIgnored"), dropFragment: field("dropFragment"),
    dropBroadcast: field("dropBroadcast"), dropTcpNotSyn: field("dropTcpNotSyn"), dropOtherProtocol: field("dropOtherProtocol"),
    dropDhcpIgnored: field("dropDhcpIgnored"), dropInboundFull: field("dropInboundFull"), dropLinkReset: field("dropLinkReset"),
    stackTransmitted: field("stackTransmitted"), framesOut: field("framesOut"), bytesOut: field("bytesOut"),
    outboundQueued: field("outboundQueued"), outboundDropFull: field("outboundDropFull"),
    outboundDropLinkReset: field("outboundDropLinkReset"), opensRequested: field("opensRequested"), openBusy: field("openBusy"),
    openConnected: field("openConnected"), openRefused: field("openRefused"), openTimedOut: field("openTimedOut"),
    openCanceled: field("openCanceled"), openingNow: field("openingNow"), connectionsOpenNow: field("connectionsOpenNow"),
    connectionsClosed: field("connectionsClosed"), connectionsReset: field("connectionsReset"),
    fallbackAttempts: field("fallbackAttempts"), framingErrors: field("framingErrors"),
    egressHeld: schemaVersion >= 46 ? total(router["egressHeld"]) : 0n,
    dropEgressPending: schemaVersion >= 46 ? total(router["dropEgressPending"]) : 0n,
    replyDns: schemaVersion >= 46 ? total(router["replyDns"]) : 0n,
  };
  if (!netstackCountersReconcile(counters)) throw protocolError("router counters do not reconcile");
  return counters;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw protocolError(`${label} is not one of ${allowed.join(", ")}`);
  return found;
}

function count(value: unknown, label: string): number {
  return integer(value, `network bridge ${label}`, 0);
}

function total(value: unknown): bigint {
  const decoded = bigint(value, "network counter");
  if (decoded < 0n || decoded > 0xffff_ffff_ffff_ffffn) throw protocolError("network counters are unsigned 64-bit values");
  return decoded;
}
