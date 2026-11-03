import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha1 } from "./sha1.js";
import { MemoryNetwork, PASS_THROUGH_TLS, VM_ADDRESS, type MemoryConnection } from "./memory-network.js";
import { createWebSocket } from "./websocket.js";

const text = new TextDecoder(), encoder = new TextEncoder();

/** The server's frames are unmasked. */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const head = payload.length < 126 ? [fin ? 0x80 | opcode : opcode, payload.length] : [fin ? 0x80 | opcode : opcode, 126, payload.length >> 8, payload.length & 0xff];
  return new Uint8Array([...head, ...payload]);
}

/** Decodes the client's masked frames from a buffer; returns the frames and what is left. */
function clientFrames(buffer: Uint8Array): { readonly frames: { opcode: number; payload: Uint8Array }[]; readonly rest: Uint8Array } {
  const frames: { opcode: number; payload: Uint8Array }[] = [];
  let at = 0;
  for (;;) {
    if (buffer.length - at < 2) break;
    const opcode = (buffer[at] ?? 0) & 0x0f, short = (buffer[at + 1] ?? 0) & 0x7f;
    const extra = short === 126 ? 2 : short === 127 ? 8 : 0, length = extra === 2 ? ((buffer[at + 2] ?? 0) << 8 | (buffer[at + 3] ?? 0)) : short;
    const start = at + 2 + extra + 4;
    if (buffer.length < start + length) break;
    const mask = buffer.subarray(at + 2 + extra, start);
    frames.push({ opcode, payload: buffer.slice(start, start + length).map((byte, index) => byte ^ (mask[index & 3] ?? 0)) });
    at = start + length;
  }
  return { frames, rest: buffer.slice(at) };
}

type Behaviour = (frame: { opcode: number; payload: Uint8Array }, connection: MemoryConnection) => void;

function wsServer(net: MemoryNetwork, port: number, behaviour: Behaviour, handshake?: (key: string) => string) {
  const buffers = new Map<MemoryConnection, Uint8Array>(), upgraded = new Set<MemoryConnection>();
  net.listen(VM_ADDRESS, port, {
    data(connection, bytes) {
      const previous = buffers.get(connection) ?? new Uint8Array();
      let buffer = new Uint8Array([...previous, ...bytes]);
      if (!upgraded.has(connection)) {
        const head = text.decode(buffer), end = head.indexOf("\r\n\r\n");
        if (end < 0) { buffers.set(connection, buffer); return; }
        const key = /sec-websocket-key: (\S+)/iu.exec(head)?.[1] ?? "";
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        connection.write(encoder.encode(handshake?.(accept) ?? `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n${/sec-websocket-protocol: chat/iu.test(head) ? "sec-websocket-protocol: chat\r\n" : ""}\r\n`));
        upgraded.add(connection); buffer = buffer.slice(end + 4);
      }
      const { frames, rest } = clientFrames(buffer);
      buffers.set(connection, rest);
      for (const frame of frames) behaviour(frame, connection);
    },
  });
}

function setup() {
  const net = new MemoryNetwork("vm");
  net.file("/etc/hosts", `${VM_ADDRESS} vm\n`);
  const WS = createWebSocket({ sockets: net.sockets(), reach: "vm", tls: PASS_THROUGH_TLS, signal: new AbortController().signal });
  return { net, WS };
}

function events(socket: EventTarget, type: string): Promise<Event> { return new Promise(resolve => { socket.addEventListener(type, resolve, { once: true }); }); }

describe("module WebSocket (ADR 0029, RFC 6455)", () => {
  it("computes SHA-1 as the standard does", () => {
    for (const input of ["", "abc", "a".repeat(1000)]) expect(Buffer.from(sha1(encoder.encode(input))).toString("hex")).toBe(createHash("sha1").update(input).digest("hex"));
  });

  it("echoes text and binary, answers pings, and closes cleanly with the server's code", async () => {
    const { net, WS } = setup();
    wsServer(net, 9000, (frame, connection) => {
      if (frame.opcode === 1 || frame.opcode === 2) { connection.write(serverFrame(9, encoder.encode("p"))); connection.write(serverFrame(frame.opcode, frame.payload)); }
      if (frame.opcode === 10) connection.write(serverFrame(1, encoder.encode(`pong:${text.decode(frame.payload)}`)));
      if (frame.opcode === 8) { connection.write(serverFrame(8, frame.payload)); connection.end(); }
    });
    const socket = new WS("ws://vm:9000/echo", ["chat"]);
    socket.binaryType = "arraybuffer";
    const messages: unknown[] = [];
    socket.addEventListener("message", event => { if (event instanceof MessageEvent) messages.push(event.data); });
    await events(socket, "open");
    expect([socket.readyState, socket.protocol]).toEqual([1, "chat"]);
    socket.send("hello"); socket.send(new Uint8Array([1, 2, 3]));
    await expect.poll(() => messages.length).toBe(4);
    // Pings are answered as they arrive, so the pong echoes interleave with the echoes.
    expect(messages.filter(item => item === "pong:p")).toHaveLength(2);
    expect(messages.filter(item => item !== "pong:p")).toEqual(["hello", new Uint8Array([1, 2, 3]).buffer]);
    const closed = events(socket, "close");
    socket.close(4001, "bye");
    const event = await closed;
    expect(event).toMatchObject({ code: 4001, reason: "bye", wasClean: true });
    expect(socket.readyState).toBe(3);
    expect(() => { socket.close(1001); }).toThrow(DOMException);
  });

  it("assembles fragments and fails the connection on a text message that is not UTF-8", async () => {
    const { net, WS } = setup();
    wsServer(net, 9001, (frame, connection) => {
      if (text.decode(frame.payload) === "fragments") { connection.write(serverFrame(1, encoder.encode("hel"), false)); connection.write(serverFrame(0, encoder.encode("lo"), true)); }
      if (text.decode(frame.payload) === "bad-utf8") connection.write(serverFrame(1, new Uint8Array([0xff, 0xfe])));
    });
    const socket = new WS("ws://vm:9001/");
    const message = events(socket, "message");
    await events(socket, "open");
    socket.send("fragments");
    const received = await message;
    expect(received instanceof MessageEvent ? received.data : null).toBe("hello");
    const error = events(socket, "error"), closed = events(socket, "close");
    socket.send("bad-utf8");
    await error;
    expect(await closed).toMatchObject({ code: 1006, wasClean: false });
  });

  it("refuses a handshake whose accept key is wrong, and a VM-only module cannot reach the internet", async () => {
    const { net, WS } = setup();
    wsServer(net, 9002, () => undefined, () => "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: wrong\r\n\r\n");
    const socket = new WS("ws://vm:9002/"), opened = vi_fn();
    socket.addEventListener("open", opened);
    expect(await events(socket, "close")).toMatchObject({ code: 1006 });
    expect(opened.calls).toBe(0);
    const outside = new WS("ws://93.184.215.14/");
    await events(outside, "error");
    expect(net.attempts.at(-1)).toMatchObject({ address: "93.184.215.14", errno: 13 });
    expect(() => new WS("ftp://vm/")).toThrow(DOMException);
  });
});

function vi_fn(): { calls: number } & (() => void) {
  const state = { calls: 0 };
  return Object.assign(() => { state.calls++; }, { get calls() { return state.calls; } });
}
