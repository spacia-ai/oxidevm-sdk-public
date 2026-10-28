import { expect, it, vi } from "vitest";
import { LinuxClient } from "../../js-process/transport.js";
import { JS_MAILBOX_BYTES, LinuxError } from "../../js-process/codec.js";
import { networkInterfaces } from "./network-interfaces.js";

function message(type: number, sequence: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array((16 + body.length + 3) & ~3), view = new DataView(bytes.buffer);
  view.setUint32(0, 16 + body.length, true); view.setUint16(4, type, true);
  view.setUint32(8, sequence, true); bytes.set(body, 16); return bytes;
}
function attribute(type: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array((4 + body.length + 3) & ~3), view = new DataView(bytes.buffer);
  view.setUint16(0, 4 + body.length, true); view.setUint16(2, type, true); bytes.set(body, 4); return bytes;
}
function fixture(): Uint8Array {
  const link = new Uint8Array(16), view = new DataView(link.buffer);
  view.setUint32(4, 1, true); view.setUint32(8, 0x49, true);
  const join = (parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(part => [...part]));
  return join([
    message(16, 1, join([link, attribute(3, new TextEncoder().encode("lo\0")), attribute(1, new Uint8Array(6))])), message(3, 1, new Uint8Array()),
    message(20, 2, join([Uint8Array.of(2, 8, 0x80, 254, 1, 0, 0, 0), attribute(2, Uint8Array.of(127, 0, 0, 1))])),
    message(20, 2, join([Uint8Array.of(10, 128, 0x80, 254, 1, 0, 0, 0), attribute(1, Uint8Array.of(...new Uint8Array(15), 1))])), message(3, 2, new Uint8Array()),
  ]);
}

it("reads fresh Linux netlink data and closes the descriptor after each enumeration", () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  let reply = fixture(); const calls: number[] = [];
  vi.spyOn(client, "sync").mockImplementation(operation => {
    calls.push(operation.number);
    if (operation.number === 41) return operation.decode({ value: 7n, bytes: new Uint8Array() });
    if (operation.number === 0) return operation.decode({ value: BigInt(reply.length), bytes: reply });
    return operation.decode({ value: operation.number === 1 ? BigInt(operation.payload.length - 12) : 0n, bytes: new Uint8Array() });
  });
  try {
    expect(networkInterfaces(client)).toEqual({ lo: [
      { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
      { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", mac: "00:00:00:00:00:00", internal: true, cidr: "::1/128", scopeid: 0 },
    ] });
    reply = new Uint8Array(); expect(() => networkInterfaces(client)).toThrow(/netlink/u);
    expect(calls).toEqual([41, 1, 0, 3, 41, 1, 0, 3]);
  } finally { client.dispose(); channel.port2.close(); }
});

it.each([0, 15, 17, 0xffff_ffff])("rejects malformed message length %s and closes the descriptor", length => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const reply = fixture(); new DataView(reply.buffer).setUint32(0, length, true);
  const close = vi.fn();
  vi.spyOn(client, "sync").mockImplementation(operation => {
    if (operation.number === 41) return operation.decode({ value: 7n, bytes: new Uint8Array() });
    if (operation.number === 0) return operation.decode({ value: BigInt(reply.length), bytes: reply });
    if (operation.number === 3) close();
    return operation.decode({ value: operation.number === 1 ? BigInt(operation.payload.length - 12) : 0n, bytes: new Uint8Array() });
  });
  try { expect(() => networkInterfaces(client)).toThrow(); expect(close).toHaveBeenCalledOnce(); }
  finally { client.dispose(); channel.port2.close(); }
});

it("keeps Linux netlink errors distinct from malformed transport replies", () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const body = new Uint8Array(20); new DataView(body.buffer).setInt32(0, -13, true);
  const reply = message(2, 1, body);
  vi.spyOn(client, "sync").mockImplementation(operation => {
    if (operation.number === 41) return operation.decode({ value: 7n, bytes: new Uint8Array() });
    if (operation.number === 0) return operation.decode({ value: BigInt(reply.length), bytes: reply });
    return operation.decode({ value: operation.number === 1 ? BigInt(operation.payload.length - 12) : 0n, bytes: new Uint8Array() });
  });
  try { expect(() => networkInterfaces(client)).toThrowError(new LinuxError(13)); }
  finally { client.dispose(); channel.port2.close(); }
});
