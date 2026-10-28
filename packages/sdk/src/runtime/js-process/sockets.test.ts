import { expect, it } from "vitest";
import { decodeAddress, encodeAddress } from "./sockets.js";

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
