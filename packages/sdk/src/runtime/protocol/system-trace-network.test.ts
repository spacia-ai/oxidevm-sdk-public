import { describe, expect, it } from "vitest";

import { VMError } from "../errors.ts";
import { decodeSystemTraceNetworkProfile, type SystemTraceNetworkProfile } from "./system-trace-network.ts";

const drops = { queueFull: 0n, oversize: 0n, malformed: 0n };

/** Transmit: 3 = responder 0 + taken 2 + queued 1. Receive: given 4 = delivered 3 + queued 1. */
const CORE: NonNullable<SystemTraceNetworkProfile["core"]> = {
  backend: "host-link",
  transmit: { frames: 3n, bytes: 180n, responder: 0n, takenFrames: 2n, takenBytes: 120n, drops, queued: 1n },
  receive: {
    givenFrames: 4n, givenBytes: 240n, responderReplies: 0n, drops, restored: 0n, queued: 1n,
    deliveredFrames: 3n, deliveredBytes: 180n, framingErrors: 0n,
  },
};

/** I1: 2 in = 2 to smoltcp. I2: 2 sent = 2 out. I3: 1 open = 1 connected. I4: 1 = 1 open now. */
const ROUTER: NonNullable<SystemTraceNetworkProfile["router"]> = {
  egressHeld: 0n, dropEgressPending: 0n, replyDns: 0n,
  framesIn: 2n, bytesIn: 120n, toStack: 2n, inboundQueued: 0n,
  replyArp: 0n, replyDhcpOffer: 0n, replyDhcpAck: 0n, replyDhcpNak: 0n, replyTcpReset: 0n, replyIcmpProhibited: 0n,
  dropMalformed: 0n, dropNotForRouter: 0n, dropIpv6: 0n, dropOtherEthertype: 0n, dropArpIgnored: 0n, dropFragment: 0n,
  dropBroadcast: 0n, dropTcpNotSyn: 0n, dropOtherProtocol: 0n, dropDhcpIgnored: 0n, dropInboundFull: 0n, dropLinkReset: 0n,
  stackTransmitted: 2n, framesOut: 2n, bytesOut: 120n, outboundQueued: 0n, outboundDropFull: 0n, outboundDropLinkReset: 0n,
  opensRequested: 1n, openBusy: 0n, openConnected: 1n, openRefused: 0n, openTimedOut: 0n, openCanceled: 0n, openingNow: 0n,
  connectionsOpenNow: 1n, connectionsClosed: 0n, connectionsReset: 0n, fallbackAttempts: 0n, framingErrors: 0n,
};

const PROFILE: SystemTraceNetworkProfile = {
  link: "attached",
  failure: null,
  generation: 3,
  bridge: { givenFrames: 4, givenBytes: 240, takenFrames: 2, takenBytes: 120, giveBackpressure: 0, takeRingFull: 0, kicks: 2 },
  core: CORE,
  router: ROUTER,
};

function codeOf(value: unknown, schemaVersion: 42 | 43 | 46 = 46): string {
  try {
    decodeSystemTraceNetworkProfile(value, schemaVersion);
  } catch (error: unknown) {
    if (error instanceof VMError) return error.code;
    throw error;
  }
  return "decoded";
}

describe("system trace network profile", () => {
  it("is null before schema 43, which had none", () => {
    expect(decodeSystemTraceNetworkProfile(undefined, 42)).toBeNull();
    expect(codeOf(PROFILE, 42)).toBe("PROTOCOL_ERROR");
  });

  it("round-trips an exact schema-46 profile", () => {
    expect(decodeSystemTraceNetworkProfile(structuredClone(PROFILE), 46)).toEqual(PROFILE);
  });

  it("retains historical schema-43 captures, whose external counters are zero", () => {
    const legacy = Object.fromEntries(Object.entries(ROUTER).filter(([key]) => !["egressHeld", "dropEgressPending", "replyDns"].includes(key)));
    expect(decodeSystemTraceNetworkProfile({...PROFILE, router: legacy}, 43)).toEqual(PROFILE);
    expect(codeOf({...PROFILE, router: legacy}, 46)).toBe("PROTOCOL_ERROR");
  });

  it("is null for a capture that recorded none, such as a checkpoint", () => {
    expect(decodeSystemTraceNetworkProfile(null, 43)).toBeNull();
  });

  it("accepts a VM without the link, whose core still has the test responder", () => {
    const absent: SystemTraceNetworkProfile = {
      ...PROFILE,
      link: "absent",
      generation: 0,
      core: { ...CORE, backend: "test-responder" },
      router: null,
      bridge: { givenFrames: 0, givenBytes: 0, takenFrames: 0, takenBytes: 0, giveBackpressure: 0, takeRingFull: 0, kicks: 0 },
    };
    expect(decodeSystemTraceNetworkProfile(structuredClone(absent), 43)).toEqual(absent);
    const failed = { ...PROFILE, link: "failed", failure: "trap" } as const;
    expect(decodeSystemTraceNetworkProfile(structuredClone(failed), 46)).toEqual(failed);
  });

  it.each([
    ["an extra key", { ...PROFILE, extra: 1 }],
    ["an unknown link state", { ...PROFILE, link: "linked" }],
    ["an unknown failure", { ...PROFILE, failure: "crash" }],
    ["a negative bridge count", { ...PROFILE, bridge: { ...PROFILE.bridge, kicks: -1 } }],
    ["a generation beyond 31 bits", { ...PROFILE, generation: 0x8000_0000 }],
    ["a core counter that is not a bigint", { ...PROFILE, core: { ...CORE, transmit: { ...CORE.transmit, frames: 3 } } }],
    ["a router counter that is not a bigint", { ...PROFILE, router: { ...ROUTER, framesIn: 2 } }],
    ["core counters that do not reconcile", { ...PROFILE, core: { ...CORE, transmit: { ...CORE.transmit, frames: 4n } } }],
    ["router counters that do not reconcile", { ...PROFILE, router: { ...ROUTER, framesIn: 3n } }],
    ["a router counter missing", { ...PROFILE, router: { ...ROUTER, framingErrors: undefined } }],
  ])("rejects %s", (_name, value) => {
    expect(codeOf(value)).toBe("PROTOCOL_ERROR");
  });
});
