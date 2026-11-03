import { describe, expect, it } from "vitest";
import { datagram, decodeAddress, encodeAddress } from "./sockets.js";
import { Writer } from "./codec.js";
import type { ClientSockets } from "../../wasm/capabilities.js";

it.each([
  { family: "ipv4", address: "127.0.0.1", port: 0x1234 },
  { family: "ipv6", address: "0:0:0:0:0:0:0:1", port: 65535 },
  { family: "unix", path: "/tmp/bridge.sock" },
  { family: "unix", path: "\0abstract" },
] as const)("round trips a numeric or Unix address: %j", address => {
  expect(decodeAddress(encodeAddress(address))).toEqual(address);
});
it("expands IPv6 compressed numeric addresses and refuses hostname resolution", () => {
  expect(decodeAddress(encodeAddress({ family: "ipv6", address: "::1", port: 80 }))).toEqual({ family: "ipv6", address: "0:0:0:0:0:0:0:1", port: 80 });
  expect(() => encodeAddress({ family: "ipv4", address: "example.com", port: 80 })).toThrow();
  expect(() => encodeAddress({ family: "ipv6", address: "localhost", port: 80 })).toThrow();
  expect(() => encodeAddress({ family: "ipv6", address: "1::2::3", port: 80 })).toThrow();
});

describe("datagram sockets for the runner's resolver (OXJR 41 with a type, 44 with a destination, 45; Userspace API 146)", () => {
  const resolver = { family: "ipv4", address: "10.0.2.3", port: 53 } as const;

  it("opens an AF_INET or AF_INET6 SOCK_DGRAM socket with {u32 family, u32 type}", () => {
    const open = datagram.socket("ipv4");
    expect(open.number).toBe(41);
    expect(Array.from(open.payload)).toEqual([2, 0, 0, 0, 2, 0, 0, 0]);
    expect(Array.from(datagram.socket("ipv6").payload)).toEqual([10, 0, 0, 0, 2, 0, 0, 0]);
    expect(open.decode({ value: 5n, bytes: new Uint8Array() })).toBe(5);
  });

  it("sends to a destination: fd, blob(bytes), flags, blob(address), and answers the count sent", () => {
    const query = Uint8Array.of(0x12, 0x34, 1, 0), send = datagram.sendTo(5, query, resolver);
    expect(send.number).toBe(44);
    expect(Array.from(send.payload)).toEqual(Array.from(new Writer().u64(5).blob(query).u64(0x4000).blob(encodeAddress(resolver)).finish()));
    expect(send.decode({ value: 4n, bytes: new Uint8Array() })).toBe(4);
    expect(() => send.decode({ value: 5n, bytes: new Uint8Array() })).toThrow();
  });

  it("receives a datagram with its source: the reply is u32 address length, the address, then the bytes", () => {
    const receive = datagram.receiveFrom(5, 512, { dontWait: true, peek: true });
    expect(receive.number).toBe(45);
    expect(Array.from(receive.payload)).toEqual(Array.from(new Writer().u64(5).u64(512).u64(0x40 | 0x2).finish()));
    const source = encodeAddress(resolver), answer = Uint8Array.of(0x12, 0x34, 0x81, 0x80);
    const reply = new Writer().u32(source.byteLength).raw(source).raw(answer).finish();
    expect(receive.decode({ value: 4n, bytes: reply })).toEqual({ bytes: answer, source: resolver });
    expect(Array.from(datagram.receiveFrom(5, 512).payload.subarray(16))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    for (const bytes of [reply.subarray(0, 3), new Writer().u32(200).raw(source).finish(), new Writer().u32(source.byteLength).raw(source).raw(answer).raw(answer).finish()]) {
      expect(() => receive.decode({ value: 4n, bytes })).toThrow();
    }
  });

  it("is the runner's alone: a module's client sockets have no datagram member", () => {
    const members: readonly (keyof ClientSockets)[] = ["socket", "connect", "address", "read", "write", "close", "shutdown"];
    expect(members).not.toContain("sendTo");
  });
});
