// The router module's raw ABI (ADR 0015, NETSTACK_API_VERSION 1): its exact exports, its
// connection status codes and its counter record. Every value the module returns is checked here
// before the network worker uses it.
import { VMError } from "./errors.ts";

export const NETSTACK_API_VERSION = 2;
/** The module's I/O buffer: a whole 1 MiB ring of frame records plus one connection read. */
export const NETSTACK_BUFFER_BYTES = 1_114_112;
export const NETSTACK_COUNTERS_VERSION = 2;
export const NETSTACK_COUNTERS_BYTES = 352;

export const NETSTACK_EXPORTS = [
  "oxidevm_netstack_api_version",
  "oxidevm_netstack_buffer_ptr",
  "oxidevm_netstack_buffer_capacity",
  "oxidevm_netstack_init",
  "oxidevm_netstack_frames_in",
  "oxidevm_netstack_frames_out",
  "oxidevm_netstack_poll",
  "oxidevm_netstack_tcp_open",
  "oxidevm_netstack_tcp_status",
  "oxidevm_netstack_tcp_send",
  "oxidevm_netstack_tcp_receive",
  "oxidevm_netstack_tcp_close",
  "oxidevm_netstack_counters",
  "oxidevm_netstack_network_set",
  "oxidevm_netstack_egress_next",
  "oxidevm_netstack_egress_complete",
  "oxidevm_netstack_egress_status",
  "oxidevm_netstack_egress_send",
  "oxidevm_netstack_egress_receive",
] as const;
export type NetstackExport = typeof NETSTACK_EXPORTS[number];

/** What a Rust wasm32 cdylib exports besides its functions. */
export const NETSTACK_LINKER_EXPORTS = ["memory", "__data_end", "__heap_base"] as const;

export type RouterConnectionState =
  | "opening"
  | "connected"
  | "peer-closed"
  | "refused"
  | "timed-out"
  | "reset"
  | "closed";

const STATES: readonly RouterConnectionState[] = [
  "opening",
  "connected",
  "peer-closed",
  "refused",
  "timed-out",
  "reset",
  "closed",
];
const READABLE = 0x100;
const WRITABLE = 0x200;

export interface RouterConnectionStatus {
  readonly state: RouterConnectionState;
  readonly readable: boolean;
  readonly writable: boolean;
}

/** `oxidevm_netstack_tcp_status`: the state code in the low byte, then a readable bit (only
 * while connected) and a writable bit (while connected or after Linux closed its end). */
export function decodeRouterConnectionStatus(value: number): RouterConnectionStatus {
  if (!Number.isInteger(value) || value < 0 || (value & ~(0xff | READABLE | WRITABLE)) !== 0) {
    throw protocolError(`router connection status ${String(value)} has unknown bits`);
  }
  const state = STATES[value & 0xff];
  if (state === undefined) throw protocolError(`router connection state ${String(value & 0xff)} is unknown`);
  const readable = (value & READABLE) !== 0;
  const writable = (value & WRITABLE) !== 0;
  if ((readable && state !== "connected") || (writable && state !== "connected" && state !== "peer-closed")) {
    throw protocolError(`a ${state} router connection cannot be readable or writable`);
  }
  return { state, readable, writable };
}

/** The router's counters (record version 1, 40 little-endian u64 fields). */
export interface NetstackCounters {
  readonly framesIn: bigint;
  readonly bytesIn: bigint;
  readonly toStack: bigint;
  readonly inboundQueued: bigint;
  readonly replyArp: bigint;
  readonly replyDhcpOffer: bigint;
  readonly replyDhcpAck: bigint;
  readonly replyDhcpNak: bigint;
  readonly replyTcpReset: bigint;
  readonly replyIcmpProhibited: bigint;
  readonly dropMalformed: bigint;
  readonly dropNotForRouter: bigint;
  readonly dropIpv6: bigint;
  readonly dropOtherEthertype: bigint;
  readonly dropArpIgnored: bigint;
  readonly dropFragment: bigint;
  readonly dropBroadcast: bigint;
  readonly dropTcpNotSyn: bigint;
  readonly dropOtherProtocol: bigint;
  readonly dropDhcpIgnored: bigint;
  readonly dropInboundFull: bigint;
  readonly dropLinkReset: bigint;
  readonly stackTransmitted: bigint;
  readonly framesOut: bigint;
  readonly bytesOut: bigint;
  readonly outboundQueued: bigint;
  readonly outboundDropFull: bigint;
  readonly outboundDropLinkReset: bigint;
  readonly opensRequested: bigint;
  readonly openBusy: bigint;
  readonly openConnected: bigint;
  readonly openRefused: bigint;
  readonly openTimedOut: bigint;
  readonly openCanceled: bigint;
  readonly openingNow: bigint;
  readonly connectionsOpenNow: bigint;
  readonly connectionsClosed: bigint;
  readonly connectionsReset: bigint;
  readonly fallbackAttempts: bigint;
  readonly framingErrors: bigint;
  readonly egressHeld: bigint;
  readonly dropEgressPending: bigint;
  readonly replyDns: bigint;
}

/** The counter record `oxidevm_netstack_counters` writes; it must reconcile (I1–I4). */
export function decodeNetstackCounters(bytes: Uint8Array): NetstackCounters {
  if (bytes.byteLength !== NETSTACK_COUNTERS_BYTES) throw protocolError("router counters have the wrong length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== NETSTACK_COUNTERS_VERSION) throw protocolError("unsupported router counters version");
  if (view.getUint32(4, true) !== 43) throw protocolError("router counters have the wrong field count");
  let offset = 8;
  const next = (): bigint => {
    const value = view.getBigUint64(offset, true);
    offset += 8;
    return value;
  };
  const counters: NetstackCounters = {
    framesIn: next(),
    bytesIn: next(),
    toStack: next(),
    inboundQueued: next(),
    replyArp: next(),
    replyDhcpOffer: next(),
    replyDhcpAck: next(),
    replyDhcpNak: next(),
    replyTcpReset: next(),
    replyIcmpProhibited: next(),
    dropMalformed: next(),
    dropNotForRouter: next(),
    dropIpv6: next(),
    dropOtherEthertype: next(),
    dropArpIgnored: next(),
    dropFragment: next(),
    dropBroadcast: next(),
    dropTcpNotSyn: next(),
    dropOtherProtocol: next(),
    dropDhcpIgnored: next(),
    dropInboundFull: next(),
    dropLinkReset: next(),
    stackTransmitted: next(),
    framesOut: next(),
    bytesOut: next(),
    outboundQueued: next(),
    outboundDropFull: next(),
    outboundDropLinkReset: next(),
    opensRequested: next(),
    openBusy: next(),
    openConnected: next(),
    openRefused: next(),
    openTimedOut: next(),
    openCanceled: next(),
    openingNow: next(),
    connectionsOpenNow: next(),
    connectionsClosed: next(),
    connectionsReset: next(),
    fallbackAttempts: next(),
    framingErrors: next(),
    egressHeld: next(),
    dropEgressPending: next(),
    replyDns: next(),
  };
  if (!netstackCountersReconcile(counters)) throw protocolError("router counters do not reconcile");
  return counters;
}

/** I1 frames in, I2 frames out, I3 opens and I4 connections each add up. */
export function netstackCountersReconcile(c: NetstackCounters): boolean {
  const replies = c.replyArp + c.replyDhcpOffer + c.replyDhcpAck + c.replyDhcpNak + c.replyTcpReset + c.replyIcmpProhibited + c.replyDns;
  const drops = c.dropMalformed + c.dropNotForRouter + c.dropIpv6 + c.dropOtherEthertype + c.dropArpIgnored
    + c.dropFragment + c.dropBroadcast + c.dropTcpNotSyn + c.dropOtherProtocol + c.dropDhcpIgnored
    + c.dropInboundFull + c.dropLinkReset + c.dropEgressPending;
  return c.framesIn === c.toStack + c.inboundQueued + c.egressHeld + replies + drops
    && c.stackTransmitted + replies === c.framesOut + c.outboundQueued + c.outboundDropFull + c.outboundDropLinkReset
    && c.opensRequested === c.openBusy + c.openConnected + c.openRefused + c.openTimedOut + c.openCanceled + c.openingNow
    && c.openConnected === c.connectionsOpenNow + c.connectionsClosed + c.connectionsReset;
}

/** The module exports exactly the ABI's functions plus the linker's memory and two globals. */
export function validateNetstackExports(exports: readonly WebAssembly.ModuleExportDescriptor[]): void {
  const expected = new Map<string, WebAssembly.ImportExportKind>([
    ...NETSTACK_EXPORTS.map((name): [string, WebAssembly.ImportExportKind] => [name, "function"]),
    ["memory", "memory"],
    ["__data_end", "global"],
    ["__heap_base", "global"],
  ]);
  for (const { name, kind } of exports) {
    const wanted = expected.get(name);
    if (wanted === undefined) throw exportsError(`the router module exports ${name}, which the ABI does not have`);
    if (wanted !== kind) throw exportsError(`the router module exports ${name} as a ${kind}, not a ${wanted}`);
    expected.delete(name);
  }
  const missing = [...expected.keys()];
  if (missing.length > 0) throw exportsError(`the router module does not export ${missing.join(", ")}`);
}

function protocolError(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}

function exportsError(message: string): VMError {
  return new VMError("CORE_LOAD_FAILED", message, { component: "netstack", reason: "exports" });
}


export type RouterEgressEvent =
  | {readonly kind: "tcp"; readonly generation: number; readonly id: number; readonly address: Uint8Array<ArrayBuffer>; readonly port: 80 | 443}
  | {readonly kind: "dns"; readonly generation: number; readonly id: number; readonly query: Uint8Array<ArrayBuffer>};
export function decodeRouterEgressEvent(bytes: Uint8Array): RouterEgressEvent {
  if (bytes.byteLength < 32 || bytes.byteLength > 4128) throw protocolError("Invalid outbound event length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const generation = view.getUint32(8, true), id = view.getUint32(12, true), length = view.getUint32(24, true);
  if (view.getUint32(0, false) !== 0x4f584e45 || view.getUint16(4, true) !== 2 || bytes[7] !== 0 || generation === 0 || id === 0 || id === 0xffff_ffff || length !== bytes.byteLength - 32 || view.getUint16(22, true) !== 0 || view.getUint32(28, true) !== 0) throw protocolError("Invalid outbound event identity");
  if (bytes[6] === 1 && length === 0) {
    const port = view.getUint16(20, true);
    if (port !== 80 && port !== 443) throw protocolError("Invalid outbound port");
    const address = new Uint8Array(16); address.set(bytes.subarray(16,20));
    return {kind: "tcp", generation, id, address, port};
  }
  if (bytes[6] === 2 && length >= 12 && view.getUint32(16, true) === 0 && view.getUint16(20, true) === 0) return {kind: "dns", generation, id, query: bytes.slice(32)};
  throw protocolError("Invalid outbound event kind");
}
export function decodeRouterEgressStatus(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 16 || (value !== 0 && value !== 16 && (value & 1) === 0)) throw protocolError("Invalid outbound socket state");
  return value;
}
