import { describe, expect, it } from "vitest";

import { VMError } from "./errors.ts";
import {
  decodeNetstackCounters,
  decodeRouterConnectionStatus,
  NETSTACK_COUNTERS_BYTES,
  NETSTACK_EXPORTS,
  NETSTACK_LINKER_EXPORTS,
  validateNetstackExports,
} from "./netstack-abi.ts";

/** The router's counter fields, in record order. */
const FIELDS = [
  "framesIn", "bytesIn", "toStack", "inboundQueued",
  "replyArp", "replyDhcpOffer", "replyDhcpAck", "replyDhcpNak", "replyTcpReset", "replyIcmpProhibited",
  "dropMalformed", "dropNotForRouter", "dropIpv6", "dropOtherEthertype", "dropArpIgnored", "dropFragment",
  "dropBroadcast", "dropTcpNotSyn", "dropOtherProtocol", "dropDhcpIgnored", "dropInboundFull", "dropLinkReset",
  "stackTransmitted", "framesOut", "bytesOut", "outboundQueued", "outboundDropFull", "outboundDropLinkReset",
  "opensRequested", "openBusy", "openConnected", "openRefused", "openTimedOut", "openCanceled", "openingNow",
  "connectionsOpenNow", "connectionsClosed", "connectionsReset", "fallbackAttempts", "framingErrors", "egressHeld", "dropEgressPending", "replyDns",
] as const;
type Field = typeof FIELDS[number];

/** I1: 10 in = 4 to smoltcp + 1 queued + 3 replies + 2 drops. I2: 5 sent + 3 replies = 6 out + 1
 * queued + 1 dropped. I3: 6 opens = 1 busy + 2 connected + 1 refused + 1 timed out + 1 opening.
 * I4: 2 connected = 1 open + 1 closed. */
const CONSISTENT: Readonly<Record<Field, bigint>> = {
  framesIn: 10n, bytesIn: 600n, toStack: 4n, inboundQueued: 1n,
  replyArp: 2n, replyDhcpOffer: 0n, replyDhcpAck: 0n, replyDhcpNak: 0n, replyTcpReset: 1n, replyIcmpProhibited: 0n,
  dropMalformed: 1n, dropNotForRouter: 0n, dropIpv6: 1n, dropOtherEthertype: 0n, dropArpIgnored: 0n, dropFragment: 0n,
  dropBroadcast: 0n, dropTcpNotSyn: 0n, dropOtherProtocol: 0n, dropDhcpIgnored: 0n, dropInboundFull: 0n, dropLinkReset: 0n,
  stackTransmitted: 5n, framesOut: 6n, bytesOut: 400n, outboundQueued: 1n, outboundDropFull: 1n, outboundDropLinkReset: 0n,
  opensRequested: 6n, openBusy: 1n, openConnected: 2n, openRefused: 1n, openTimedOut: 1n, openCanceled: 0n, openingNow: 1n,
  egressHeld: 0n, dropEgressPending: 0n, replyDns: 0n,
  connectionsOpenNow: 1n, connectionsClosed: 1n, connectionsReset: 0n, fallbackAttempts: 1n, framingErrors: 2n,
};

function record(
  fields: Partial<Record<Field, bigint>> = {},
  header: { readonly version?: number; readonly count?: number; readonly length?: number } = {},
): Uint8Array {
  const bytes = new Uint8Array(header.length ?? NETSTACK_COUNTERS_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.version ?? 2, true);
  view.setUint32(4, header.count ?? 43, true);
  FIELDS.forEach((name, index) => {
    if (8 + index * 8 + 8 <= bytes.byteLength) view.setBigUint64(8 + index * 8, fields[name] ?? CONSISTENT[name], true);
  });
  return bytes;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof VMError) return error.code;
    throw error;
  }
  return "none";
}

function descriptors(
  overrides: Readonly<Record<string, WebAssembly.ImportExportKind | null>> = {},
): WebAssembly.ModuleExportDescriptor[] {
  const kinds: Record<string, WebAssembly.ImportExportKind | null> = {
    memory: "memory",
    __data_end: "global",
    __heap_base: "global",
    ...Object.fromEntries(NETSTACK_EXPORTS.map((name) => [name, "function"])),
    ...overrides,
  };
  return Object.entries(kinds).flatMap(([name, kind]) => (kind === null ? [] : [{ name, kind }]));
}

describe("router connection status", () => {
  it.each([
    [0, { state: "opening", readable: false, writable: false }],
    [1 | 0x100 | 0x200, { state: "connected", readable: true, writable: true }],
    [1, { state: "connected", readable: false, writable: false }],
    [2 | 0x200, { state: "peer-closed", readable: false, writable: true }],
    [3, { state: "refused", readable: false, writable: false }],
    [4, { state: "timed-out", readable: false, writable: false }],
    [5, { state: "reset", readable: false, writable: false }],
    [6, { state: "closed", readable: false, writable: false }],
  ])("decodes %i", (value, expected) => {
    expect(decodeRouterConnectionStatus(value)).toEqual(expected);
  });

  it.each([7, 0xff, 0x400, 1 | 0x400, -1, 1.5, 0x100, 2 | 0x100, 3 | 0x200, 6 | 0x300])("rejects %s", (value) => {
    expect(codeOf(() => decodeRouterConnectionStatus(value))).toBe("PROTOCOL_ERROR");
  });
});

describe("router counters", () => {
  it("decodes the record into its 40 fields", () => {
    expect(decodeNetstackCounters(record())).toEqual(CONSISTENT);
  });

  it.each([
    ["one byte short", record({}, { length: NETSTACK_COUNTERS_BYTES - 1 })],
    ["one byte long", record({}, { length: NETSTACK_COUNTERS_BYTES + 1 })],
    ["version 1", record({}, { version: 1 })],
    ["39 fields", record({}, { count: 39 })],
    ["frames in that do not add up (I1)", record({ framesIn: 11n })],
    ["frames out that do not add up (I2)", record({ framesOut: 7n })],
    ["opens that do not add up (I3)", record({ opensRequested: 7n })],
    ["connections that do not add up (I4)", record({ connectionsClosed: 2n })],
  ])("rejects %s", (_name, bytes) => {
    expect(codeOf(() => decodeNetstackCounters(bytes))).toBe("PROTOCOL_ERROR");
  });
});

describe("router module exports", () => {
  it("accepts exactly the ABI's functions and the linker's memory and globals", () => {
    expect(() => { validateNetstackExports(descriptors()); }).not.toThrow();
    expect(NETSTACK_LINKER_EXPORTS).toEqual(["memory", "__data_end", "__heap_base"]);
  });

  it.each([
    ["a missing function", { oxidevm_netstack_poll: null }],
    ["an extra export", { oxidevm_netstack_debug: "function" }],
    ["memory exported as a function", { memory: "function" }],
    ["a linker global exported as a function", { __heap_base: "function" }],
    ["an ABI function exported as a global", { oxidevm_netstack_init: "global" }],
  ] as const)("rejects %s", (_name, overrides) => {
    const error = (() => {
      try {
        validateNetstackExports(descriptors(overrides));
      } catch (caught: unknown) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason: "exports" } });
  });
});
