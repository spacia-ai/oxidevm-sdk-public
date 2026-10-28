import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayConnection } from "./relay-protocol.js";
import { UserspaceRelay } from "./userspace-relay.js";
import { decodeRelayFrame, encodeRelayFrame, decodeRelayTicket, RelayKind, RELAY_MAX_CREDIT } from "./relay-wire.js";
import { NetstackEgress } from "./netstack/egress.js";
import type { NetstackRouterApi } from "./netstack/router.js";
import type { RouterEgressEvent } from "../netstack-abi.js";

class MockWebSocket {
  static latest: MockWebSocket;
  binaryType = "blob";
  bufferedAmount = 0;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: (ArrayBuffer | string)[] = [];
  closed = false;
  constructor(readonly url: URL, readonly protocol: string) {
    MockWebSocket.latest = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(value: ArrayBuffer | string): void { this.sent.push(value); }
  close(): void { this.closed = true; this.readyState = 3; }
  receive(value: ArrayBuffer | string): void {
    this.onmessage?.(new MessageEvent("message", { data: value }));
  }
}
const identity = { workspaceId: "workspace", browserSessionId: "a".repeat(32) };
const peer = { transport: "tcp", family: 2, address: new Uint8Array([93, 184, 216, 34, ...Array<number>(12).fill(0)]), port: 443 } as const;
const signal = (): AbortSignal => new AbortController().signal;
async function authenticated(): Promise<RelayConnection> {
  vi.stubGlobal("WebSocket", MockWebSocket);
  const pending = RelayConnection.connect({ webSocketUrl: "wss://relay.example/v2/socket", ticket: "b".repeat(64), expiresAt: Date.now() + 30_000 }, identity, signal());
  await Promise.resolve();
  MockWebSocket.latest.receive(JSON.stringify({ version: 2, sessionId: "9", expiresAt: Date.now() + 43_200_000 }));
  return pending;
}
function incoming(kind: number, stream: bigint, sequence: bigint, payload = new Uint8Array(), window = 0): ArrayBuffer {
  return encodeRelayFrame({ kind, session: 9n, stream, sequence, payload, window });
}
function sentFrames() {
  return MockWebSocket.latest.sent.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer).map(value => decodeRelayFrame(value, 9n));
}

describe("relay protocol v2", () => {
  afterEach(() => { MockWebSocket.latest.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("preserves a valid late frame through 65 local closes while another stream stays usable", async () => {
    const relay = await authenticated();
    const first = relay.open(1n, peer, signal());
    MockWebSocket.latest.receive(incoming(RelayKind.OPENED, 1n, 0n, new Uint8Array(), 131072)); await first;
    relay.close(1n);
    const canceled: Promise<void>[] = [];
    for (let stream = 2n; stream <= 65n; stream++) {
      canceled.push(relay.open(stream, peer, signal()).catch(() => {}));
      relay.close(stream);
    }
    await Promise.all(canceled);
    const active = relay.open(66n, peer, signal());
    MockWebSocket.latest.receive(incoming(RelayKind.OPENED, 66n, 0n, new Uint8Array(), 131072)); await active;
    MockWebSocket.latest.receive(incoming(RelayKind.DATA, 1n, 1n, new Uint8Array([7])));
    expect(MockWebSocket.latest.closed).toBe(false);
    MockWebSocket.latest.receive(incoming(RelayKind.DATA, 66n, 1n, new Uint8Array([8])));
    expect(await relay.receive(66n, 8, signal())).toEqual(new Uint8Array([8]));
    relay.dispose();
  });
  it("keeps retirement PING behind a buffered RESET", async () => {
    vi.useFakeTimers();
    const relay = await authenticated();
    const opened = relay.open(1n, peer, signal());
    MockWebSocket.latest.receive(incoming(RelayKind.OPENED, 1n, 0n, new Uint8Array(), 131072)); await opened;
    MockWebSocket.latest.bufferedAmount = RELAY_MAX_CREDIT;
    relay.close(1n); await Promise.resolve();
    expect(sentFrames().map(frame => frame.kind)).toEqual([RelayKind.OPEN]);
    MockWebSocket.latest.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(20);
    expect(sentFrames().map(frame => frame.kind)).toEqual([RelayKind.OPEN, RelayKind.RESET, RelayKind.PING]);
    relay.dispose();
  });
  it("keeps a newer retirement through an older PONG and rejects frames after its own barrier", async () => {
    const relay = await authenticated();
    const barriers: bigint[] = [];
    for (const stream of [1n, 2n]) {
      const opened = relay.open(stream, peer, signal());
      MockWebSocket.latest.receive(incoming(RelayKind.OPENED, stream, 0n, new Uint8Array(), 131072)); await opened;
      relay.close(stream); await Promise.resolve();
      const ping = sentFrames().filter(frame => frame.kind === RelayKind.PING).at(-1); if (ping === undefined) throw new Error("Missing retirement barrier");
      barriers.push(ping.sequence);
    }
    const [older, newer] = barriers; if (older === undefined || newer === undefined) throw new Error("Missing barrier identity");
    MockWebSocket.latest.receive(incoming(RelayKind.PONG, 0n, older));
    MockWebSocket.latest.receive(incoming(RelayKind.DATA, 2n, 1n, new Uint8Array([7])));
    expect(MockWebSocket.latest.closed).toBe(false);
    MockWebSocket.latest.receive(incoming(RelayKind.PONG, 0n, newer));
    MockWebSocket.latest.receive(incoming(RelayKind.DATA, 2n, 2n, new Uint8Array([8])));
    expect(MockWebSocket.latest.closed).toBe(true);
    relay.dispose();
  });
  it("bounds unacknowledged retirement without losing an active stream and recovers both admissions", async () => {
    const relay = await authenticated();
    const active = relay.open(1n, peer, signal());
    MockWebSocket.latest.receive(incoming(RelayKind.OPENED, 1n, 0n, new Uint8Array(), 131072)); await active;
    const canceled: Promise<void>[] = [];
    for (let stream = 2n; stream <= 128n; stream++) {
      canceled.push(relay.open(stream, peer, signal()).catch(() => {})); relay.close(stream);
    }
    await Promise.all(canceled);
    await expect(relay.open(129n, peer, signal())).rejects.toMatchObject({ detail: { reason: "quota-exceeded" } });
    await expect(relay.fetch("https://registry.npmjs.org/is-number", { allowedOrigins: ["https://registry.npmjs.org"], accept: "application/json", maximumBytes: 1024 }, signal())).rejects.toMatchObject({ detail: { reason: "quota-exceeded" } });
    MockWebSocket.latest.receive(incoming(RelayKind.DATA, 1n, 1n, new Uint8Array([9])));
    expect(await relay.receive(1n, 8, signal())).toEqual(new Uint8Array([9]));
    const ping = sentFrames().find(frame => frame.kind === RelayKind.PING); if (ping === undefined) throw new Error("Missing retirement barrier");
    MockWebSocket.latest.receive(incoming(RelayKind.PONG, 0n, ping.sequence));
    const reopened = relay.open(129n, peer, signal());
    MockWebSocket.latest.receive(incoming(RelayKind.OPENED, 129n, 0n, new Uint8Array(), 131072)); await reopened;
    expect(MockWebSocket.latest.closed).toBe(false);
    const fetched = relay.fetch("https://registry.npmjs.org/is-number", { allowedOrigins: ["https://registry.npmjs.org"], accept: "application/json", maximumBytes: 1024 }, signal());
    MockWebSocket.latest.receive(incoming(RelayKind.RESET, 130n, 0n, new TextEncoder().encode("destination-denied")));
    await expect(fetched).rejects.toMatchObject({ detail: { reason: "destination-denied" } });
    relay.dispose();
  });
  it("does not send a queued retirement PING after disposal", async () => {
    const relay = await authenticated();
    const pending = relay.open(1n, peer, signal()).catch(() => {});
    relay.close(1n); relay.dispose(); await pending;
    expect(sentFrames().some(frame => frame.kind === RelayKind.PING)).toBe(false);
  });
  it.each([0, 2] as const)("discards already-credited data after local read shutdown %s without losing another stream", async how => {
    const relay = await authenticated();
    const first = relay.open(1n, peer, signal());
    MockWebSocket.latest.receive(incoming(2, 1n, 0n, new Uint8Array(), 131072)); await first;
    const second = relay.open(2n, peer, signal());
    MockWebSocket.latest.receive(incoming(2, 2n, 0n, new Uint8Array(), 131072)); await second;
    relay.shutdown(1n, how);
    MockWebSocket.latest.receive(incoming(3, 1n, 1n, new Uint8Array([1, 2])));
    expect(MockWebSocket.latest.closed).toBe(false);
    expect(await relay.receive(1n, 8, signal())).toEqual(new Uint8Array());
    MockWebSocket.latest.receive(incoming(3, 2n, 1n, new Uint8Array([3, 4])));
    expect(await relay.receive(2n, 8, signal())).toEqual(new Uint8Array([3, 4]));
    const returned = sentFrames().filter(frame => frame.kind === RelayKind.WINDOW && frame.stream === 1n);
    expect(returned).toEqual([]);
    relay.dispose();
  });
  it("still rejects data sent after the peer's write EOF when reads were also shut locally", async () => {
    const relay = await authenticated();
    const pending = relay.open(1n, peer, signal());
    MockWebSocket.latest.receive(incoming(2, 1n, 0n, new Uint8Array(), 131072)); await pending;
    relay.shutdown(1n, 0);
    MockWebSocket.latest.receive(incoming(4, 1n, 1n, new Uint8Array([1])));
    MockWebSocket.latest.receive(incoming(3, 1n, 2n, new Uint8Array([1])));
    expect(MockWebSocket.latest.closed).toBe(true);
    relay.dispose();
  });
  it("authenticates in the first message and never puts credentials in the URL", async () => {
    const relay = await authenticated();
    expect(MockWebSocket.latest.url.search).toBe("");
    expect(MockWebSocket.latest.protocol).toBe("oxidevm-relay-v2");
    const first = MockWebSocket.latest.sent[0];
    if (typeof first !== "string") throw new Error("Authentication was not the first message");
    const decoded: unknown = JSON.parse(first);
    expect(decoded).toEqual({ version: 2, ticket: "b".repeat(64), ...identity });
    relay.dispose();
  });
  it("streams HTTPS GET through the same credit owner and accepts only validated response headers", async () => {
    const relay = await authenticated();
    const fetching = relay.fetch("https://registry.npmjs.org/package", {maximumBytes:1024,allowedOrigins:["https://registry.npmjs.org"],accept:"application/json"}, signal());
    MockWebSocket.latest.receive(incoming(2,1n,0n,new Uint8Array(),131072));
    MockWebSocket.latest.receive(incoming(10,1n,1n,new TextEncoder().encode(JSON.stringify({status:200,headers:{"content-type":"application/json"}}))));
    const response=await fetching;
    MockWebSocket.latest.receive(incoming(3,1n,2n,new TextEncoder().encode("{}")));
    MockWebSocket.latest.receive(incoming(4,1n,3n,new Uint8Array([1])));
    expect(await response.text()).toBe("{}");expect(response.headers.has("content-length")).toBe(false);
    expect(decodeRelayFrame(MockWebSocket.latest.sent[1] instanceof ArrayBuffer ? MockWebSocket.latest.sent[1] : new ArrayBuffer(0),9n).kind).toBe(9);
    relay.dispose();
  });
  it("retains EOF, enforces directional shutdown, and returns credit only on consumption", async () => {
    const relay = await authenticated();
    const opening = relay.open(7n, peer, signal());
    MockWebSocket.latest.receive(incoming(2, 7n, 0n, new Uint8Array(), 262144));
    await opening;
    MockWebSocket.latest.receive(incoming(3, 7n, 1n, new Uint8Array([4, 5])));
    expect(MockWebSocket.latest.sent).toHaveLength(2);
    MockWebSocket.latest.receive(incoming(4, 7n, 2n, new Uint8Array([1])));
    await expect(relay.receive(7n, 1, signal())).resolves.toEqual(new Uint8Array([4]));
    await expect(relay.receive(7n, 9, signal())).resolves.toEqual(new Uint8Array([5]));
    await expect(relay.receive(7n, 9, signal())).resolves.toEqual(new Uint8Array());
    await expect(relay.receive(7n, 9, signal())).resolves.toEqual(new Uint8Array());
    relay.shutdown(7n, 1);
    await expect(relay.send(7n, new Uint8Array([1]), signal())).rejects.toThrow();
    relay.dispose();
  });
  it("preserves DNS datagrams when a short read discards their tail", async () => {
    const relay = await authenticated();
    const opening = relay.open(8n, { ...peer, transport: "udp", port: 53 }, signal());
    MockWebSocket.latest.receive(incoming(2, 8n, 0n, new Uint8Array(), 262144));
    await opening;
    MockWebSocket.latest.receive(incoming(3, 8n, 1n, new Uint8Array([1, 2, 3])));
    MockWebSocket.latest.receive(incoming(3, 8n, 2n, new Uint8Array([4, 5])));
    await expect(relay.receive(8n, 2, signal())).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(relay.receive(8n, 8, signal())).resolves.toEqual(new Uint8Array([4, 5]));
    relay.dispose();
  });
  it("serializes a guest's concurrent DNS sends and early receive through one opening stream", async () => {
    const relay=await authenticated();const adapter=new UserspaceRelay();adapter.setRelay(relay,1);
    const operation={kind:"send-to",socket:8n,family:2,address:new Uint8Array([192,0,2,1,...Array<number>(12).fill(0)]),port:53,bytes:new Uint8Array([1,2,3])} as const;
    const first=adapter.execute(1n,operation,signal());
    const second=adapter.execute(1n,operation,signal());
    const reading=adapter.execute(1n,{kind:"receive-from",socket:8n,maxBytes:64},signal());
    MockWebSocket.latest.receive(incoming(2,1n,0n,new Uint8Array(),131072));
    MockWebSocket.latest.receive(incoming(3,1n,1n,new Uint8Array([4,5])));
    await expect(first).resolves.toEqual({kind:"sent",bytes:3});await expect(second).resolves.toEqual({kind:"sent",bytes:3});
    await expect(reading).resolves.toMatchObject({kind:"received-from",bytes:new Uint8Array([4,5]),port:53});
    expect(MockWebSocket.latest.sent.filter(value=>value instanceof ArrayBuffer&&decodeRelayFrame(value,9n).kind===1)).toHaveLength(1);
    relay.dispose();
  });
  it("keeps a pending System DNS request alive when the router pumps before its reply", async () => {
    const relay = await authenticated();
    const query = new Uint8Array([1, 2, 3]);
    const answer = new Uint8Array([4, 5, 6]);
    const router = {
      init: vi.fn(), framesIn: vi.fn(() => 0), framesOut: vi.fn(() => new Uint8Array()),
      poll: vi.fn(() => undefined), open: vi.fn(() => ({ kind: "busy" } as const)),
      status: vi.fn(() => ({ state: "closed", readable: false, writable: false } as const)),
      send: vi.fn(() => 0), receive: vi.fn(() => new Uint8Array()), close: vi.fn(),
      counters: vi.fn(() => new Uint8Array(352)), setNetwork: vi.fn(),
      egressNext: vi.fn<() => RouterEgressEvent | undefined>()
        .mockReturnValueOnce({ kind: "dns", generation: 1, id: 7, query }),
      egressComplete: vi.fn(() => true), egressStatus: vi.fn(() => 0),
      egressSend: vi.fn(() => 0), egressReceive: vi.fn(() => new Uint8Array()),
    } satisfies NetstackRouterApi;
    const egress = new NetstackEgress(router, vi.fn());
    try {
      await egress.setRelay(relay, 1);
      egress.wake();
      MockWebSocket.latest.receive(incoming(2, 1n, 0n, new Uint8Array(), 131072));
      await vi.waitFor(() => {
        expect(MockWebSocket.latest.sent.filter(value => value instanceof ArrayBuffer && decodeRelayFrame(value, 9n).kind === 3)).toHaveLength(1);
      });
      egress.wake();
      expect(router.egressStatus).not.toHaveBeenCalled();
      expect(MockWebSocket.latest.sent.filter(value => value instanceof ArrayBuffer && decodeRelayFrame(value, 9n).kind === 5)).toHaveLength(0);
      MockWebSocket.latest.receive(incoming(3, 1n, 1n, answer));
      await vi.waitFor(() => { expect(router.egressComplete).toHaveBeenCalledWith(1, 7, 5, answer); });
    } finally { egress.reset(); relay.dispose(); }
  });
  it("cancels a credit-blocked write and rejects replayed sequences", async () => {
    const relay = await authenticated();
    const opening = relay.open(9n, peer, signal());
    MockWebSocket.latest.receive(incoming(2, 9n, 0n));
    await opening;
    const controller = new AbortController();
    const pending = relay.send(9n, new Uint8Array([1]), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    MockWebSocket.latest.receive(incoming(6, 9n, 1n, new Uint8Array(), 1));
    expect(MockWebSocket.latest.sent).toHaveLength(2);
    MockWebSocket.latest.receive(incoming(3, 9n, 1n, new Uint8Array([2])));
    expect(MockWebSocket.latest.closed).toBe(true);
    relay.dispose();
  });
  it("closes when upstream exceeds the advertised window", async () => {
    const relay = await authenticated();
    const opening = relay.open(10n, peer, signal());
    MockWebSocket.latest.receive(incoming(2, 10n, 0n, new Uint8Array(), 262144));
    await opening;
    for (let i = 1; i <= 5; i++) MockWebSocket.latest.receive(incoming(3, 10n, BigInt(i), new Uint8Array(65536)));
    expect(MockWebSocket.latest.closed).toBe(true);
    relay.dispose();
  });
  it("rejects version 1, extra fields, credentials in URLs, and invalid frame shapes", () => {
    const valid = { version: 2, webSocketUrl: "wss://relay.example/v2/socket", ticket: "b".repeat(64), expiresAt: Date.now() + 30000 };
    expect(() => decodeRelayTicket({ ...valid, version: 1 }, new URL("https://relay.example/"))).toThrow();
    expect(() => decodeRelayTicket({ ...valid, extra: true }, new URL("https://relay.example/"))).toThrow();
    expect(() => decodeRelayTicket({ ...valid, webSocketUrl: "wss://relay.example/v2/socket?token=secret" }, new URL("https://relay.example/"))).toThrow();
    expect(() => decodeRelayFrame(incoming(6, 1n, 0n), 9n)).toThrow();
    expect(() => decodeRelayFrame(incoming(3, 0n, 0n, new Uint8Array([1])), 9n)).toThrow();
  });
});
