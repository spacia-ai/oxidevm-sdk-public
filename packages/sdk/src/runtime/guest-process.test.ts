import { describe, expect, it, vi } from "vitest";

import { GuestProcessTransport } from "./guest-process.js";
import { PROTOCOL_VERSION } from "./protocol.js";

describe("guest process transport", () => {
  it("replays a saved output tail before live bytes without acknowledging the tail again", async () => {
    const channel = new MessageChannel();
    const initialStdout = new Uint8Array([65]);
    const process = new GuestProcessTransport(channel.port1, 7, 3, {
      initialStdout,
      write: bytes => Promise.resolve(bytes.length), closeStdin: async () => {}, signal: async () => {},
    });
    initialStdout.fill(90);
    const acknowledgements: unknown[] = [];
    channel.port2.addEventListener("message", (event: MessageEvent<unknown>) => { acknowledgements.push(event.data); });
    channel.port2.start();
    channel.port2.postMessage({ version: PROTOCOL_VERSION, sessionId: 3, sequence: 1, type: "stdout", data: new Uint8Array([66]) });
    const reader = process.stdout.getReader();
    try {
      await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([65]) });
      await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([66]) });
      await vi.waitFor(() => expect(acknowledgements).toEqual([{ version: PROTOCOL_VERSION, sessionId: 3, type: "output-ack", sequence: 1 }]));
    } finally {
      channel.port2.postMessage({ version: PROTOCOL_VERSION, sessionId: 3, sequence: 2, type: "exit", termination: { kind: "exit", code: 0 } });
      await process.exit;
      channel.port2.close();
      reader.releaseLock();
    }
  });

  it("streams output, acknowledges it, and settles exit once", async () => {
    const channel = new MessageChannel();
    const write = vi.fn((bytes: Uint8Array) =>
      Promise.resolve(bytes.byteLength),
    );
    const closeStdin = vi.fn(() => Promise.resolve());
    const signal = vi.fn(() => Promise.resolve());
    const process = new GuestProcessTransport(channel.port1, 7, 3, {
      write,
      closeStdin,
      signal,
    });
    const acknowledgement = new Promise<unknown>((resolve) => {
      channel.port2.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => resolve(event.data),
        { once: true },
      );
      channel.port2.start();
    });
    channel.port2.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: 3,
      sequence: 1,
      type: "stdout",
      data: new Uint8Array([79, 75]),
    });
    const reader = process.stdout.getReader();
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array([79, 75]),
    });
    await expect(acknowledgement).resolves.toEqual({
      version: PROTOCOL_VERSION,
      sessionId: 3,
      type: "output-ack",
      sequence: 1,
    });
    channel.port2.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: 3,
      sequence: 2,
      type: "exit",
      termination: { kind: "exit", code: 0 },
    });
    await expect(process.exit).resolves.toEqual({ code: 0 });
    channel.port2.close();
  });

  it("preserves signal termination while keeping the public exit shape", async () => {
    const channel = new MessageChannel();
    const process = new GuestProcessTransport(channel.port1, 7, 3, {
      write: (bytes) => Promise.resolve(bytes.byteLength),
      closeStdin: () => Promise.resolve(),
      signal: () => Promise.resolve(),
    });
    channel.port2.postMessage({
      version: PROTOCOL_VERSION,
      sessionId: 3,
      sequence: 1,
      type: "exit",
      termination: { kind: "signal", signal: 9 },
    });
    await expect(process.exit).resolves.toEqual({ code: null, signal: "SIGKILL" });
    channel.port2.close();
  });

  it("forwards stdin, close, and supported signals", async () => {
    const channel = new MessageChannel();
    const write = vi.fn((bytes: Uint8Array) =>
      Promise.resolve(bytes.byteLength),
    );
    const closeStdin = vi.fn(() => Promise.resolve());
    const signal = vi.fn(() => Promise.resolve());
    const process = new GuestProcessTransport(channel.port1, 7, 3, {
      write,
      closeStdin,
      signal,
    });
    const writer = process.stdin.getWriter();
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();
    await process.kill("INT");
    expect(write).toHaveBeenCalledOnce();
    expect(closeStdin).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith("INT");
    await expect(process.kill("NOPE")).rejects.toThrow("unsupported guest signal");
    channel.port1.close();
    channel.port2.close();
  });
});

it("settles returned process streams when their control owner disappears", async () => {
  const owner = new AbortController();
  const channel = new MessageChannel();
  const process = new GuestProcessTransport(channel.port1, 1, 1, {
    lifetime: owner.signal,
    write: bytes => Promise.resolve(bytes.length),
    closeStdin: async () => {}, signal: async () => {},
  });
  const reason = new Error("control owner lost");
  const stdout = process.stdout.getReader(); const stderr = process.stderr.getReader();
  const stdin = process.stdin.getWriter();
  const pending = [expect(stdin.closed).rejects.toBe(reason), expect(process.exit).rejects.toBe(reason), expect(stdout.read()).rejects.toBe(reason), expect(stderr.read()).rejects.toBe(reason)];
  owner.abort(reason);
  await Promise.all(pending);
  stdin.releaseLock(); stdout.releaseLock(); stderr.releaseLock(); channel.port2.close();
});

it("routes PTY resize and rejects invalid or unavailable controls", async () => {
  const channel = new MessageChannel();
  const resizeTerminal = vi.fn(async () => {});
  const control = { write: (bytes: Uint8Array) => Promise.resolve(bytes.length), closeStdin: async () => {}, signal: async () => {} };
  const process = new GuestProcessTransport(channel.port1, 7, 3, { ...control, resizeTerminal });
  await process.resizeTerminal({ columns: 132, rows: 43 });
  expect(resizeTerminal).toHaveBeenCalledWith({ columns: 132, rows: 43 });
  await expect(process.resizeTerminal({ columns: 0, rows: 43 })).rejects.toThrow("Invalid");
  const unsupported = new GuestProcessTransport(channel.port2, 8, 4, control);
  await expect(unsupported.resizeTerminal({ columns: 80, rows: 24 })).rejects.toThrow("unavailable");
  channel.port1.close(); channel.port2.close();
});
